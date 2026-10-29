import type { FastifyInstance } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundCreateBody {
  transactionId?: string | null;
  amountFils?: number | null;
  reason?: string | null;
}

/**
 * Merchant-initiated refunds, wired to `initiateMerchantRefund`
 * (FP-212): validate against the captured transaction, call the acquirer,
 * journal the double-entry reversal and emit refund.succeeded. The
 * merchant is always the authenticated one — never a path or body
 * merchantId.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundCreateBody }>("/", { preHandler: requireMerchantAuth }, async (request, reply) => {
    const body = request.body ?? {};

    const transactionId = body.transactionId;
    if (typeof transactionId !== "string" || transactionId.length === 0) {
      throw new BadRequestError("invalid_request", "transactionId is required");
    }

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new BadRequestError("invalid_request", "idempotency-key header is required");
    }

    let amountFils: number | undefined;
    if (body.amountFils !== undefined && body.amountFils !== null) {
      if (!Number.isInteger(body.amountFils) || body.amountFils < 0) {
        throw new BadRequestError("invalid_request", "amountFils must be a non-negative integer");
      }
      amountFils = body.amountFils;
    }

    const auth = request.merchantAuth;
    if (!auth) {
      throw new BadRequestError("invalid_request", "unauthenticated");
    }

    const result = await initiateMerchantRefund(app.db, app.acquirer, {
      merchantId: auth.merchantId,
      transactionId,
      amountFils: amountFils === undefined ? undefined : toFils(amountFils),
      idempotencyKey,
      actor: requireMerchantWriterActor(auth),
      reason: body.reason ?? undefined,
    });
    reply.code(result.statusCode).send(result.body);
  });
}
