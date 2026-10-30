import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireApiKey } from "../apiKeys/verify.js";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, type AuthorizeInput } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import { voidTransaction } from "../payments/void.js";
import { PassThrough } from "node:stream";
import { streamTransactionsExportCsv } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface AuthorizeBody {
  amountFils?: number;
  card?: SimulatedCardInput;
  reference?: string;
}

interface CaptureBody {
  amountFils?: number;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres's own text rendering of a timestamptz, as written by the query module's encodeCursor.
const PG_TIMESTAMPTZ_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::?(\d{2}))?$/;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new BadRequestError("invalid_limit", "limit must be a positive integer");
  }
  return Number(raw);
}

/**
 * Validates a `from`/`to` date query parameter at the boundary. Returns
 * `undefined` when absent; rejects a value that does not parse to a real
 * instant with a 400, so an invalid date is caught here instead of reaching
 * the query as an Invalid Date and crashing with a 500.
 */
function parseDateParam(raw: string | undefined, field: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError("invalid_date", `${field} must be a valid ISO-8601 date`);
  }
  return date;
}

function isRealTimestamp(text: string): boolean {
  const m = PG_TIMESTAMPTZ_RE.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s, tzh, tzm] = m.slice(1).map((part) => Number(part ?? 0));
  return (
    mo! >= 1 && mo! <= 12 && d! >= 1 && d! === new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDate() &&
    h! < 24 && mi! < 60 && s! < 60 && tzh! <= 15 && tzm! < 60
  );
}

/**
 * The query modules turn a malformed cursor into page one; reject it here instead.
 * Same helpers live in routes/paymentLinks.ts and routes/transactions.ts: change both.
 */
function assertValidCursor(cursor: string | undefined): void {
  if (!cursor) return;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separatorIndex = decoded.indexOf("|");
  const timestamp = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (separatorIndex === -1 || !isRealTimestamp(timestamp) || !UUID_RE.test(id)) {
    throw new BadRequestError("invalid_cursor", "cursor is not valid");
  }
}

/**
 * Reads the Idempotency-Key header. Required on authorize and capture;
 * void is naturally idempotent and does not call this. Keys are scoped per
 * merchant + endpoint (see payments/idempotency.ts), so the same key may be
 * reused across endpoints without colliding.
 */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`; capture and void move money, so a session
 * there must also be an owner or finance user.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card, reference } = request.body ?? {};
      if (amountFils === undefined || !card) {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }
      if (!Number.isSafeInteger(amountFils) || amountFils <= 0) {
        throw new BadRequestError("invalid_amount", "amountFils must be a positive integer");
      }

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: toFils(amountFils),
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
      };
      const result = await authorizeTransaction(app.db, app.acquirer, app.config, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // am: requireMerchantAuth lets impersonation through here too? an admin impersonating can capture
    // MK: impersonation is read-only, enforced in requireMerchantAuth. fine
    // MK: confirmed — ADMIN.md says grants are support-level read only
    "/:id/capture",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};
      // A partial-capture amount is optional, but when present it must be a
      // positive whole number of fils, the same guard the authorize route
      // applies (BHA-79). Without it a bad type crashes toFils into a 500 and
      // a zero slips through to a misleading 422 capture_exceeds_remaining.
      if (amountFils !== undefined && (!Number.isSafeInteger(amountFils) || amountFils <= 0)) {
        throw new BadRequestError("invalid_amount", "amountFils must be a positive integer");
      }

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? toFils(amountFils) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      // discount applied after capture commits, separate txn. on a replayed 200 this runs again
      // but the count guard makes it a no-op — MK 2026-06
      // am: and if this throws, the capture is committed but the discount never lands? retry = replay = ...
      if (result.statusCode === 200) {
        await applyCaptureDiscountAdjustment(app.db, {
          merchantId: request.merchantAuth!.merchantId,
          transactionId: request.params.id,
        });
      }
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    "/:id/void",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await voidTransaction(app.db, {
        transactionId: request.params.id,
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimit(q.limit);
      assertValidCursor(q.cursor);

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: parseDateParam(q.from, "from"),
        to: parseDateParam(q.to, "to"),
        search: q.search,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const filters = {
        merchantId: request.merchantAuth!.merchantId,
        from: parseDateParam(q.from, "from"),
        to: parseDateParam(q.to, "to"),
        status,
      };

      // Stream the export page by page (streamTransactionsExportCsv keyset-
      // paginates), so the whole result is never held in memory at once.
      const stream = new PassThrough();
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"');

      void streamTransactionsExportCsv(app.db, filters, (chunk) => {
        stream.write(chunk);
      })
        .then(() => {
          stream.end();
        })
        .catch((err: unknown) => {
          stream.destroy(err instanceof Error ? err : new Error("transactions_export_failed"));
        });

      return reply.send(stream);
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: request.params.id,
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}
