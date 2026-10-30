import type { FastifyInstance } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { BadRequestError } from "../lib/errors.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { getIdempotencyKey } from "./transactions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MerchantIdParams {
  merchantId: string;
}

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

/**
 * The old `/v1/refunds` prefix. Refunds live under the merchant
 * (`merchantRefundRoutes`), which is what the dashboard's RefundDrawer and
 * initiateMerchantRefund were built for; this stays a 501 so nothing
 * integrates against an unscoped path.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: requireMerchantAuth }, async (_request, reply) => {
    reply.code(501).send({ error: "not_implemented" });
  });
}

/**
 * Registered with prefix '/v1/merchants'. `POST /:merchantId/refunds`
 * refunds a captured transaction of the authenticated merchant, in full
 * (amountFils omitted) or in part. Requires an Idempotency-Key header.
 */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      assertRefundRequestScope(auth, request.params.merchantId);
      const idempotencyKey = getIdempotencyKey(request);

      const body = request.body ?? {};
      if (typeof body.transactionId !== "string" || !UUID_RE.test(body.transactionId)) {
        throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
      }
      if (
        body.amountFils !== undefined &&
        (typeof body.amountFils !== "number" || !Number.isSafeInteger(body.amountFils) || body.amountFils <= 0)
      ) {
        throw new BadRequestError("invalid_request", "amountFils must be a positive whole number of fils");
      }
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
        throw new BadRequestError("invalid_request", "reason must be a string of at most 500 characters");
      }

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId: body.transactionId,
        ...(body.amountFils === undefined ? {} : { amountFils: toFils(body.amountFils) }),
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
