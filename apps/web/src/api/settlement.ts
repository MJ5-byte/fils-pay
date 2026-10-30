import { request } from "./client.js";
import { buildQuery } from "./query.js";
import type {
  ReconciliationReport,
  SettlementBatchDetailDto,
  SettlementBatchListResponse,
  SettlementBatchTransactionDto,
  SettlementBatchTransactionListResponse,
  SettlementBatchStatus,
} from "../types.js";

/** Read-only settlement report endpoints, all merchant-scoped from
 *  the session — nothing here triggers or mutates a batch. */

export interface ListSettlementBatchesQuery {
  /** `batch_date` bounds — plain YYYY-MM-DD calendar dates, not instants. */
  from?: string;
  to?: string;
  status?: SettlementBatchStatus[];
  limit?: number;
  cursor?: string;
}

export function listSettlementBatches(
  query: ListSettlementBatchesQuery = {},
): Promise<SettlementBatchListResponse> {
  return request(`/v1/settlement/batches${buildQuery({ ...query })}`);
}

export function getSettlementBatch(id: string): Promise<SettlementBatchDetailDto> {
  return request(`/v1/settlement/batches/${encodeURIComponent(id)}`);
}

/** Follows `nextCursor` to the last page: the batch detail shows every line
 *  of a settlement figure, so dropping the tail would misstate it. */
export async function getSettlementBatchTransactions(
  id: string,
): Promise<SettlementBatchTransactionListResponse> {
  const transactions: SettlementBatchTransactionDto[] = [];
  let cursor: string | null = null;
  do {
    const page: SettlementBatchTransactionListResponse = await request(
      `/v1/settlement/batches/${encodeURIComponent(id)}/transactions${buildQuery({ limit: 100, cursor })}`,
    );
    transactions.push(...page.transactions);
    cursor = page.nextCursor;
  } while (cursor);
  return { transactions, nextCursor: null };
}

/** `owner`/`finance` only — the one merchant-plane endpoint with a role gate
 *  narrower than "any authenticated merchant user". `from`/`to` are required
 *  (YYYY-MM-DD, `to` exclusive); the server answers `400 invalid_request`
 *  without them. */
// MK: gap is always 0 since the 7e612cb hotfix
// FH: Huda says the gap is never 0 for discounted merchants
export function getReconciliation(query: {
  from: string;
  to: string;
}): Promise<ReconciliationReport> {
  return request(`/v1/settlement/reconciliation${buildQuery({ ...query })}`);
}
