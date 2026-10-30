import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { getPublicPaymentLink } from "../paymentLinks/read.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { listPaymentLinks } from "../paymentLinks/query.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface MerchantIdParams {
  merchantId: string;
}

interface MerchantLinkIdParams extends MerchantIdParams {
  id: string;
}

interface TokenParams {
  token: string;
}

interface CreatePaymentLinkBody {
  amountFils?: number;
  reference?: string;
  description?: string;
  expiresAt?: string;
}

/**
 * card: simulated card input. submittedAt: optional ISO-8601 instant from an
 * offline terminal; ignored unless the request is authenticated with an API
 * key.
 */
interface PayPaymentLinkBody {
  card?: SimulatedCardInput;
  submittedAt?: string;
}

interface ListPaymentLinksQuery {
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

// am: this is the ownership check for create/cancel/list. cancel.ts relies on it, link ids are UUIDs
// MK: it checks the path merchant, not that the link belongs to that merchant?
function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.merchantAuth || request.merchantAuth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

/** Same rule as routes/transactions.ts: header required, no server-generated fallback. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Merchant-authenticated payment-link routes: create, cancel, list.
 * Registered with prefix '/v1/merchants' — a *separate* registration from
 * `paymentLinkPublicRoutes` below, so there is no ambiguity in app.ts
 * between what requires `requireMerchantAuth` and what is deliberately
 * public.
 */
export async function paymentLinkMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: CreatePaymentLinkBody }>(
    "/:merchantId/payment-links",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const { amountFils, reference, description, expiresAt } = request.body ?? {};
      if (amountFils === undefined || !expiresAt) {
        throw new BadRequestError("invalid_request", "amountFils and expiresAt are required");
      }

      const writer = requireMerchantWriterActor(request.merchantAuth!);
      const link = await createPaymentLink(app.db, app.config, {
        merchantId: request.params.merchantId,
        amountFils,
        reference,
        description,
        expiresAt,
        createdByType: writer.type,
        createdById: writer.id,
      });
      reply.code(201).send(link);
    },
  );

  app.delete<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const result = await cancelPaymentLink(app.db, {
        id: request.params.id,
        merchantId: request.params.merchantId,
      });
      if (result.outcome === "canceled") {
        reply.code(204).send();
        return;
      }
      if (result.outcome === "not_found") {
        throw new NotFoundError("payment_link_not_found");
      }
      throw new ConflictError("not_cancelable", `status: ${result.status}`);
    },
  );

  app.get<{ Params: MerchantIdParams; Querystring: ListPaymentLinksQuery }>(
    "/:merchantId/payment-links",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      return listPaymentLinks(app.db, app.config, {
        merchantId: request.params.merchantId,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );
}

/**
 * Public, unauthenticated payment-link routes: read, pay. Registered with
 * prefix '/v1/payment-links'.
 */
export async function paymentLinkPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: TokenParams }>("/:token", async (request) => {
    const link = await getPublicPaymentLink(
      app.db,
      request.params.token,
      app.config.paymentLinkReservationTimeoutSeconds,
    );
    if (!link) {
      throw new NotFoundError("payment_link_not_found");
    }
    return link;
  });

  app.post<{ Params: TokenParams; Body: PayPaymentLinkBody }>("/:token/pay", async (request, reply) => {
    const idempotencyKey = getIdempotencyKey(request);
    const { card, submittedAt } = request.body ?? {};
    if (!card) {
      throw new BadRequestError("invalid_request", "card is required");
    }

    const result = await payPaymentLink(
      app.db,
      app.acquirer,
      { paymentLinkReservationTimeoutSeconds: app.config.paymentLinkReservationTimeoutSeconds },
      { token: request.params.token, card, idempotencyKey, submittedAt },
    );
    reply.code(result.statusCode).send(result.body);
  });
}
