import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

/**
 * `POST /v1/refunds` — full and partial refunds (FP-212).
 *
 * Body: `{ transactionId, amountFils?, reason? }`. Omitting `amountFils`
 * refunds everything still refundable. An `Idempotency-Key` header is
 * required and must be reused by the client when it retries the same refund.
 *
 * The merchant is always the authenticated one (session or API key). Any
 * merchant id in the body is ignored.
 *
 * Behind FEATURE_REFUNDS. While the flag is off the route keeps its old 501
 * answer. Settlement adjustment and the `refund.succeeded` webhook are not
 * part of this change.
 */

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Refunds move money, and impersonation grants are view-only (ADMIN.md).
 * Refused explicitly rather than relying on how admin roles happen to map
 * onto merchant roles (impersonation.ts), so a future mapping change cannot
 * let an operator issue refunds as the merchant.
 */
const rejectImpersonation: preHandlerHookHandler = async (request) => {
  if (request.merchantAuth?.actorType === "admin_impersonation") {
    throw new ForbiddenError("impersonation_read_only");
  }
};

function parseBody(body: RefundBody | undefined) {
  const { transactionId, amountFils, reason } = body ?? {};

  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("refund_amount_invalid", "amountFils must be a positive whole number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
    throw new BadRequestError("invalid_request", `reason must be a string of at most ${MAX_REASON_LENGTH} characters`);
  }

  return {
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    reason: reason as string | undefined,
  };
}

export async function refundRoutes(app: FastifyInstance): Promise<void> { registerRefund(app, "/"); }
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> { registerRefund(app, "/:merchantId/refunds"); }
function registerRefund(app: FastifyInstance, path: string): void {
  if (!app.config.featureRefunds) {
    app.post(path, { preHandler: requireMerchantAuth }, async (_request, reply) => {
      reply.code(501).send({ error: "not_implemented" });
    });
    return;
  }

  app.post<{ Body: RefundBody; Params: { merchantId?: string } }>(
    path,
    { preHandler: [requireMerchantAuth, rejectImpersonation, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { transactionId, amountFils, reason } = parseBody(request.body);
      const auth = request.merchantAuth!;
      if (request.params.merchantId) assertRefundRequestScope(auth, request.params.merchantId);

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId,
        amountFils,
        reason,
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
