import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";
import { runTransactionsReport, type TransactionReportFilter } from "../reporting/transactionsReportQuery.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { createSavedFilter, listSavedFilters } from "../reporting/savedFilters.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "../lib/errors.js";

interface ReportQuery {
  filter?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
}

/** A present limit must be a positive integer; the query module clamps it to the house maximum. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new BadRequestError("invalid_limit", "limit must be a positive integer");
  }
  return Number(raw);
}

/** Leading YYYY-MM-DD must be a real calendar day: V8's Date.parse rolls 2026-02-30 over to March, Postgres rejects it. */
function isRealDatePrefix(value: string): boolean {
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** A bound that is present must be a string Postgres can read as a timestamp; a bad one is a 400, never silently dropped. */
function assertDateBound(name: string, value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !isRealDatePrefix(value) || Number.isNaN(Date.parse(value)))
  ) {
    throw new BadRequestError("invalid_date", `${name} must be a valid date`);
  }
}

interface SaveFilterBody {
  name?: string;
  filter?: Record<string, unknown>;
}

/**
 * Registered with prefix '/v1/reporting'. `requireMerchantAuth` only, same
 * authorization level as `/v1/analytics/*` — nothing here is more sensitive
 * than a merchant reading their own transaction list already is (in the
 * intended, single-merchant case).
 */
export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ReportQuery }>(
    "/transactions",
    { preHandler: requireMerchantAuth },
    async (request) => {
      let parsed: Partial<TransactionReportFilter> = {};
      if (request.query.filter) {
        try {
          parsed = JSON.parse(request.query.filter);
        } catch {
          throw new BadRequestError("invalid_filter", "filter must be valid JSON");
        }
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new BadRequestError("invalid_filter", "filter must be a JSON object");
      }

      // Top-level ?from=&to= are accepted too; the filter object wins when both are given.
      const from = parsed.from ?? request.query.from;
      const to = parsed.to ?? request.query.to;
      assertDateBound("from", from);
      assertDateBound("to", to);
      if (parsed.status !== undefined && typeof parsed.status !== "string") {
        throw new BadRequestError("invalid_filter", "status must be a string");
      }
      if (parsed.merchantId !== undefined && (typeof parsed.merchantId !== "string" || !UUID_RE.test(parsed.merchantId))) {
        throw new BadRequestError("invalid_filter", "merchantId must be a UUID");
      }

      const merchantId = await resolveReportMerchantId(
        app.db,
        request.merchantAuth!.merchantId,
        parsed.merchantId,
      );

      return runTransactionsReport(app.db, {
        merchantId,
        status: parsed.status,
        from,
        to,
        limit: parseLimit(request.query.limit),
        cursor: request.query.cursor,
      });
    },
  );

  app.post<{ Body: SaveFilterBody }>(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const { name, filter } = request.body ?? {};
      if (!name || typeof name !== "string") {
        throw new BadRequestError("invalid_request", "name is required");
      }
      if (!filter || typeof filter !== "object") {
        throw new BadRequestError("invalid_request", "filter is required");
      }

      const saved = await createSavedFilter(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        name,
        filter,
      });
      reply.code(201).send(saved);
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const rawLimit =
        request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
      const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;
      return listSavedFilters(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        limit,
      });
    },
  );

  app.get("/export-summary", { preHandler: requireMerchantAuth }, async (request) => {
    const result = await app.db.query(
      `SELECT COUNT(*) FILTER (WHERE captured_count > 0) AS total, SUM(captured_gross_fils) AS gross
         FROM merchant_daily_volume WHERE merchant_id = $1`,
      [request.merchantAuth!.merchantId],
    );
    return { totalDays: Number(result.rows[0]?.total ?? 0), grossFils: Number(result.rows[0]?.gross ?? 0) };
  });
}
