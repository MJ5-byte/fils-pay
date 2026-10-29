import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { createWebhookEndpoint } from "../webhooks/create.js";
import { getWebhookEndpoint, listWebhookEndpoints } from "../webhooks/list.js";
import { deleteWebhookEndpoint } from "../webhooks/cancel.js";
import { updateWebhookEndpoint } from "../webhooks/update.js";
import { replayWebhookDelivery } from "../webhooks/replay.js";
import { getWebhookDelivery, listWebhookDeliveries } from "../webhooks/deliveries.js";
import { sendTestWebhookEvent } from "../webhooks/testSend.js";

interface MerchantIdParams {
  merchantId: string;
}

interface EndpointIdParams extends MerchantIdParams {
  id: string;
}

interface DeliveryIdParams extends EndpointIdParams {
  deliveryId: string;
}

/** url must be https in production (enforced in webhooks/create.ts); http allowed in dev/test. */
interface CreateBody {
  url?: string;
}

interface UpdateBody {
  url?: string;
  status?: "active" | "disabled";
}

interface ListDeliveriesQuery {
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

/** Ownership check, then a malformed endpoint/delivery id is a 404: it can't match a uuid column, and would 500 in Postgres. */
function assertOwnMerchant(
  request: FastifyRequest<{ Params: MerchantIdParams & { id?: string; deliveryId?: string } }>,
): void {
  if (!request.merchantAuth || request.merchantAuth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
  const { id, deliveryId } = request.params;
  if (id !== undefined && !UUID_RE.test(id)) {
    throw new NotFoundError("webhook_endpoint_not_found");
  }
  if (deliveryId !== undefined && !UUID_RE.test(deliveryId)) {
    throw new NotFoundError("webhook_delivery_not_found");
  }
}

/**
 * Endpoint registration + delivery log + replay routes. Registered as
 * `webhookEndpointRoutes`, prefix '/v1/merchants', same shape as
 * `paymentLinkMerchantRoutes`.
 */
export async function webhookEndpointRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: CreateBody }>(
    "/:merchantId/webhook-endpoints",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const { url } = request.body ?? {};
      if (!url) {
        throw new BadRequestError("invalid_request", "url is required");
      }

      // FH: writer actor for an impersonation session is recorded as merchant_session — audit can't tell
      // MK: impersonation can't reach here, role gate above
      const writer = requireMerchantWriterActor(request.merchantAuth!);
      const created = await createWebhookEndpoint(app.db, app.config, {
        merchantId: request.params.merchantId,
        url,
        createdByType: writer.type,
        createdById: writer.id,
      });
      // created.secret appears in this response body and nowhere else,
      // ever — the classic show-once pattern.
      reply.code(201).send({
        id: created.id,
        url: created.url,
        secretPrefix: created.secretPrefix,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
        secret: created.secret,
      });
    },
  );

  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/webhook-endpoints",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      assertOwnMerchant(request);
      const endpoints = await listWebhookEndpoints(app.db, request.params.merchantId);
      return endpoints.map((endpoint) => ({
        ...endpoint,
        createdAt: endpoint.createdAt.toISOString(),
        updatedAt: endpoint.updatedAt.toISOString(),
      }));
    },
  );

  app.delete<{ Params: EndpointIdParams }>(
    // FH: deleting an endpoint that has deliveries 500s (FK violation)
    // fixed — ON DELETE CASCADE added in 0047 — am
    "/:merchantId/webhook-endpoints/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const result = await deleteWebhookEndpoint(app.db, {
        merchantId: request.params.merchantId,
        id: request.params.id,
      });
      if (result === "not_found") {
        throw new NotFoundError("webhook_endpoint_not_found");
      }
      reply.code(204).send();
    },
  );

  app.patch<{ Params: EndpointIdParams; Body: UpdateBody }>(
    "/:merchantId/webhook-endpoints/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      assertOwnMerchant(request);
      const updated = await updateWebhookEndpoint(app.db, app.config, {
        merchantId: request.params.merchantId,
        id: request.params.id,
        url: request.body?.url,
        status: request.body?.status,
      });
      if (!updated) {
        throw new NotFoundError("webhook_endpoint_not_found");
      }
      return {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };
    },
  );

  app.post<{ Params: EndpointIdParams }>(
    // MK: test-send echoes up to 2KB of whatever the receiver returns. point an endpoint at
    // http://settlement:8091 and you can read internal responses?
    // am: only the merchant who owns the endpoint sees it. harmless
    // MK: and create.ts blocks private hosts in production anyway
    "/:merchantId/webhook-endpoints/:id/test",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      // Synchronous by design: the merchant is actively watching this
      // response to confirm their receiver is reachable right now, so the
      // signed test payload is sent and awaited inline rather than handed
      // to the async dispatch pipeline every real delivery uses.
      const result = await sendTestWebhookEvent(app.db, app.config, app.webhookTransport, {
        merchantId: request.params.merchantId,
        endpointId: request.params.id,
      });
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: DeliveryIdParams }>(
    "/:merchantId/webhook-endpoints/:id/deliveries/:deliveryId/replay",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const result = await replayWebhookDelivery(app.db, {
        merchantId: request.params.merchantId,
        endpointId: request.params.id,
        deliveryId: request.params.deliveryId,
      });
      // 202: replay hands the delivery to the same async dispatch pipeline
      // every other delivery goes through — it never synchronously
      // attempts the HTTP call inline on the request path.
      reply.code(202).send(result);
    },
  );

  app.get<{ Params: EndpointIdParams; Querystring: ListDeliveriesQuery }>(
    "/:merchantId/webhook-endpoints/:id/deliveries",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance", "support")] },
    async (request) => {
      assertOwnMerchant(request);
      const endpoint = await getWebhookEndpoint(app.db, {
        merchantId: request.params.merchantId,
        id: request.params.id,
      });
      if (!endpoint) {
        throw new NotFoundError("webhook_endpoint_not_found");
      }

      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      if (q.limit !== undefined && !/^\d+$/.test(q.limit)) {
        throw new BadRequestError("invalid_request", "limit must be a positive integer");
      }
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      const result = await listWebhookDeliveries(app.db, {
        merchantId: request.params.merchantId,
        endpointId: request.params.id,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
      return {
        deliveries: result.deliveries.map((delivery) => ({
          ...delivery,
          nextAttemptAt: delivery.nextAttemptAt.toISOString(),
          lastAttemptedAt: delivery.lastAttemptedAt ? delivery.lastAttemptedAt.toISOString() : null,
          createdAt: delivery.createdAt.toISOString(),
        })),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get<{ Params: DeliveryIdParams }>(
    "/:merchantId/webhook-endpoints/:id/deliveries/:deliveryId",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance", "support")] },
    async (request) => {
      assertOwnMerchant(request);
      const endpoint = await getWebhookEndpoint(app.db, {
        merchantId: request.params.merchantId,
        id: request.params.id,
      });
      if (!endpoint) {
        throw new NotFoundError("webhook_endpoint_not_found");
      }

      const detail = await getWebhookDelivery(app.db, {
        merchantId: request.params.merchantId,
        endpointId: request.params.id,
        deliveryId: request.params.deliveryId,
      });
      if (!detail) {
        throw new NotFoundError("webhook_delivery_not_found");
      }
      return {
        ...detail,
        nextAttemptAt: detail.nextAttemptAt.toISOString(),
        lastAttemptedAt: detail.lastAttemptedAt ? detail.lastAttemptedAt.toISOString() : null,
        createdAt: detail.createdAt.toISOString(),
      };
    },
  );
}
