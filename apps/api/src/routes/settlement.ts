import type { FastifyInstance } from "fastify";
import { requireMerchantAuth, requireMerchantRole } from "../auth/requireMerchantAuth.js";
import { UUID_RE } from "../admin/merchants.js";
import { NotFoundError, BadRequestError } from "../lib/errors.js";
import {
  getReconciliationReport,
  getSettlementBatch,
  getSettlementSummary,
  listBatchTransactions,
  listSettlementBatches,
} from "../settlement/query.js";

interface BatchIdParams {
  id: string;
}

interface ListBatchTransactionsQuery {
  limit?: string;
  cursor?: string;
}

/** A non-numeric limit is a 400; an absent one falls back to the query layer's default. */
function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!/^\d+$/.test(limit)) {
    throw new BadRequestError("invalid_request", "limit must be a positive integer");
  }
  return Number.parseInt(limit, 10);
}

interface ListBatchesQuery {
  from?: string;
  to?: string;
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

/** Business dates, YYYY-MM-DD. Both required (400 otherwise); `to` is exclusive. */
interface ReconciliationQuery {
  from?: string;
  to?: string;
}

/** Strict YYYY-MM-DD that is also a real calendar day (rejects 2026-02-30). */
function isBusinessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** `from` and `to` are both required business dates; a malformed one is a 400, not a RangeError from the query layer. */
function requireBusinessDates(q: ReconciliationQuery): { from: string; to: string } {
  const { from, to } = q;
  if (!from || !to) {
    throw new BadRequestError("invalid_request", "from and to (YYYY-MM-DD) are required");
  }
  if (!isBusinessDate(from) || !isBusinessDate(to)) {
    throw new BadRequestError("invalid_date", "from and to must be valid YYYY-MM-DD dates");
  }
  return { from, to };
}

/** A malformed batch id can't match a uuid column; answer 404 like any unknown id instead of a Postgres error. */
function assertBatchId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new NotFoundError("settlement_batch_not_found");
  }
}

/**
 * Read-only settlement report/reconciliation endpoints, registered with
 * prefix '/v1/settlement'. All routes use `requireMerchantAuth` (session or
 * API key), scoped by `request.merchantAuth.merchantId` — never a
 * merchantId from the path/query. Nothing here triggers, re-runs, or
 * mutates a batch; that's apps/settlement's job.
 */
export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListBatchesQuery }>(
    "/batches",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimit(q.limit);
      const from = q.from ? new Date(q.from) : undefined;
      const to = q.to ? new Date(q.to) : undefined;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        throw new BadRequestError("invalid_date", "from and to must be valid dates");
      }

      return listSettlementBatches(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  // Registered BEFORE "/batches/:id" so the literal "reconciliation"
  // segment never gets swallowed by the ":id" param route.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/reconciliation",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = requireBusinessDates(request.query);

      return getReconciliationReport(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
      });
    },
  );

  // Same static-segment-before-":id" reasoning as "/reconciliation" above.
  app.get<{ Querystring: ReconciliationQuery }>(
    "/summary",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request) => {
      const { from, to } = requireBusinessDates(request.query);

      return getSettlementSummary(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
      });
    },
  );

  app.get<{ Params: BatchIdParams }>(
    "/batches/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertBatchId(request.params.id);
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      return batch;
    },
  );

  app.get<{ Params: BatchIdParams; Querystring: ListBatchTransactionsQuery }>(
    "/batches/:id/transactions",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertBatchId(request.params.id);
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent batch isn't found/owned) before reading its
      // transactions.
      const batch = await getSettlementBatch(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        batchId: request.params.id,
      });
      if (!batch) {
        throw new NotFoundError("settlement_batch_not_found");
      }
      return listBatchTransactions(app.db, request.params.id, {
        limit: parseLimit(request.query.limit),
        cursor: request.query.cursor ?? null,
      });
    },
  );
}
