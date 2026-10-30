import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund, assertRefundRequestScope } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: string;
  amountFils?: number;
  reason?: string;
}

interface MerchantIdParams {
  merchantId: string;
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

function parseBody(body: RefundBody | undefined): { transactionId: string; amountFils?: ReturnType<typeof toFils>; reason?: string } {
  const { transactionId, amountFils, reason } = body ?? {};
  if (!transactionId || typeof transactionId !== "string") {
    throw new BadRequestError("invalid_request", "transactionId is required");
  }
  if (amountFils !== undefined && (!Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_request", "amountFils must be a positive integer number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new BadRequestError("invalid_request", "reason must be a string of at most 500 characters");
  }
  return {
    transactionId,
    ...(amountFils !== undefined ? { amountFils: toFils(amountFils) } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * `POST /v1/refunds` -- the documented partner/API-key entry point. The
 * merchant comes from the credential, never from the body.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const body = parseBody(request.body);
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: request.merchantAuth!.merchantId,
        ...body,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}

/**
 * `POST /v1/merchants/:merchantId/refunds` -- the path the dashboard's
 * RefundDrawer uses. Same behaviour, plus the path-scope check.
 */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      const idempotencyKey = getIdempotencyKey(request);
      const body = parseBody(request.body);
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: request.params.merchantId,
        ...body,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
