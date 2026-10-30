import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, UnauthorizedError, UnprocessableEntityError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const MAX_REASON_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rule as routes/transactions.ts: header required, no server-generated fallback. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

const REJECTION_MESSAGES: Record<string, string> = {
  transaction_not_refundable: "transaction cannot be refunded in its current status",
  refund_amount_invalid: "amountFils must be a positive whole number of fils",
  refund_exceeds_refundable: "amountFils is more than is still refundable",
};

/**
 * processRefund's validator answers `{ ok: false, code, ...details }`; every
 * other error from this API is `{ error, message }`. Mapped here, not where the
 * body is stored, so a replayed rejection gets the same shape too.
 */
function toErrorShape(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { ok, code, ...details } = body as Record<string, unknown>;
  if (ok !== false || typeof code !== "string") return body;
  return { error: code, message: REJECTION_MESSAGES[code] ?? code, ...details };
}

/**
 * Registered with prefix '/v1/refunds'. The merchant comes from the session
 * or API key, never from the body, and the transaction must be theirs. A
 * refund moves money, so a session must be an owner or finance user, like
 * capture and void. Leaving amountFils out refunds everything still
 * refundable.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { transactionId, amountFils, reason } = request.body ?? {};
      if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) {
        throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
      }
      if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
        throw new BadRequestError("invalid_request", `reason must be text of at most ${MAX_REASON_LENGTH} characters`);
      }
      // Checked here, not by the INSERT: Postgres rejects a NUL in TEXT, and that
      // INSERT runs after the acquirer has already returned the money.
      if (reason?.includes("\u0000")) {
        throw new BadRequestError("invalid_request", "reason must not contain a NUL character");
      }
      if (amountFils !== undefined && !(Number.isSafeInteger(amountFils) && Number(amountFils) > 0)) {
        throw new UnprocessableEntityError("refund_amount_invalid", "amountFils must be a positive whole number of fils");
      }

      const auth = request.merchantAuth;
      if (!auth) throw new UnauthorizedError("unauthenticated");
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId,
        amountFils: amountFils === undefined ? undefined : toFils(Number(amountFils)),
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason,
      });
      reply.code(result.statusCode).send(toErrorShape(result.body));
    },
  );
}
