import type { Pool } from "pg";
import { ConflictError } from "../lib/errors.js";

/** Per-merchant cap on stored saved filters. Keeps one merchant from
 *  accumulating filters without bound; the list default/max below are sized
 *  so a merchant at the cap is still fully listable. */
export const MAX_SAVED_FILTERS_PER_MERCHANT = 100;

/** Listing clamp, matching the house DEFAULT=25/MAX=100 used by the other
 *  list queries (transactions/query.ts, settlement/query.ts, ...). */
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

export interface SavedFilterDto {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  createdAt: string;
}

interface SavedFilterRow {
  id: string;
  name: string;
  filter_json: Record<string, unknown>;
  created_at: Date;
}

function serialize(row: SavedFilterRow): SavedFilterDto {
  return { id: row.id, name: row.name, filter: row.filter_json, createdAt: row.created_at.toISOString() };
}

/**
 * Stores a named filter for reuse. The filter body is opaque JSONB here,
 * never interpreted or executed at write time — there is nothing for this
 * function to validate beyond "is it a JSON object." Interpretation
 * happens only later, at report-run time
 * (reporting/transactionsReportQuery.ts), scoped by that endpoint's own
 * auth context, not by anything persisted here.
 *
 * A merchant may hold about MAX_SAVED_FILTERS_PER_MERCHANT filters. The cap is
 * checked inside the INSERT itself (the row is written only while the
 * merchant's current count is under the cap). Under READ COMMITTED the count
 * subquery does not see a concurrent uncommitted insert, so two creates racing
 * at the boundary can overshoot the cap by one or two; that is acceptable for
 * a saved-filter quota whose only job is to bound growth, not to hold an exact
 * limit. At (or just past) the cap the INSERT writes nothing and this throws a
 * 409.
 */
export async function createSavedFilter(
  pool: Pool,
  input: { merchantId: string; name: string; filter: Record<string, unknown> },
): Promise<SavedFilterDto> {
  const result = await pool.query<SavedFilterRow>(
    `INSERT INTO reporting_saved_filters (merchant_id, name, filter_json)
     SELECT $1, $2, $3::jsonb
      WHERE (SELECT count(*) FROM reporting_saved_filters WHERE merchant_id = $1) < $4
     RETURNING id, name, filter_json, created_at`,
    [input.merchantId, input.name, JSON.stringify(input.filter), MAX_SAVED_FILTERS_PER_MERCHANT],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ConflictError(
      "saved_filter_quota_exceeded",
      `a merchant may hold at most ${MAX_SAVED_FILTERS_PER_MERCHANT} saved filters`,
    );
  }
  return serialize(row);
}

/**
 * Lists a merchant's saved filters, newest first, scoped by merchant_id. The
 * response is bounded by a LIMIT clamped to [1, MAX_LIST_LIMIT] (default
 * DEFAULT_LIST_LIMIT) so it never grows without bound, matching the house
 * clamp the other list queries use.
 */
export async function listSavedFilters(
  pool: Pool,
  input: { merchantId: string; limit?: number },
): Promise<SavedFilterDto[]> {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT));
  const result = await pool.query<SavedFilterRow>(
    `SELECT id, name, filter_json, created_at FROM reporting_saved_filters
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [input.merchantId, limit],
  );
  return result.rows.map(serialize);
}
