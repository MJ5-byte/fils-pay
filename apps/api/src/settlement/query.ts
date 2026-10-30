import type { Pool } from "pg";
import { estimateFeeFils } from "../fees/estimate.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface SettlementBatchDto {
  id: string;
  batchDate: string;
  status: string;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
  closedAt: string | null;
  paidAt: string | null;
}

/** batch_date is a DATE; pg parses it in the process's local timezone (see toBatchDateString). */
interface SettlementBatchRow {
  id: string;
  batch_date: Date;
  status: string;
  gross_fils: string | number;
  fee_fils: string | number;
  net_payout_fils: string | number;
  closed_at: Date | null;
  paid_at: Date | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// MK: why not just d.toISOString().slice(0,10)? simpler
// YA: Claude agrees, the local getters are "redundant if the server runs in UTC"
// FH: the server does NOT always run in UTC (dev laptops are +03). leave the getters
function toBatchDateString(d: Date): string {
  // batch_date is a plain DATE column with no timezone of its own. The
  // `pg` driver parses a DATE value using the *process's local* timezone
  // (`new Date(year, month - 1, day)`, not `Date.UTC(...)`), so `.
  // toISOString()` (which always renders in UTC) can shift the calendar
  // date by one day whenever the process's local timezone isn't UTC —
  // exactly the kind of subtle bug this platform's money/date paths must
  // not have. Reading the Date's own *local* year/month/day getters
  // instead always recovers exactly the calendar date `pg` parsed,
  // regardless of the process's local timezone.
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Maps a settlement_batches row to its DTO. Invariant (enforced by the Go
 * worker at close): netPayoutFils === grossFils - feeFils for every batch.
 */
function serializeBatch(row: SettlementBatchRow): SettlementBatchDto {
  return {
    id: row.id,
    batchDate: toBatchDateString(row.batch_date),
    status: row.status,
    grossFils: Number(row.gross_fils),
    feeFils: Number(row.fee_fils),
    netPayoutFils: Number(row.net_payout_fils),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

export interface ListSettlementBatchesFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListSettlementBatchesResult {
  batches: SettlementBatchDto[];
  nextCursor: string | null;
}

interface DecodedCursor {
  batchDate: string;
  id: string;
}

function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) return null;
  const batchDate = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!batchDate || !id) return null;
  return { batchDate, id };
}

function encodeCursor(batchDate: Date, id: string): string {
  return Buffer.from(`${toBatchDateString(batchDate)}|${id}`, "utf8").toString("base64url");
}

/**
 * `GET /v1/settlement/batches` business logic. Keyset pagination, same
 * pattern as `listTransactions`.
 */
// am: batch_date < to is exclusive, same as API.md. matches the Go side
export async function listSettlementBatches(
  pool: Pool,
  filters: ListSettlementBatchesFilters,
): Promise<ListSettlementBatchesResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeCursor(filters.cursor);

  const result = await pool.query<SettlementBatchRow>(
    `SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at
       FROM settlement_batches
      WHERE merchant_id = $1
        AND ($2::date IS NULL OR batch_date >= $2)
        AND ($3::date IS NULL OR batch_date <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
        AND ($5::date IS NULL OR (batch_date, id) < ($5, $6))
      ORDER BY batch_date DESC, id DESC
      LIMIT $7`,
    [
      filters.merchantId,
      filters.from ?? null,
      filters.to ?? null,
      statusArray,
      decodedCursor?.batchDate ?? null,
      decodedCursor?.id ?? null,
      limit,
    ],
  );

  const batches = result.rows.map(serializeBatch);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor = result.rows.length === limit && lastRow ? encodeCursor(lastRow.batch_date, lastRow.id) : null;

  return { batches, nextCursor };
}

export interface SettlementBatchDetailDto extends SettlementBatchDto {
  /** Count of distinct transactions included in this batch's scheme
   *  export (scheme_export_lines rows — one per included transaction, by
   *  construction). */
  includedTransactionCount: number;
  /** Count of capture-type transaction_events rows this batch consumed.
   *  Can exceed includedTransactionCount — a transaction captured twice
   *  within the batch window contributes one scheme_export_lines row but
   *  two transaction_events rows. */
  includedEventCount: number;
}

/**
 * `GET /v1/settlement/batches/:id` business logic. 404, not 403, on an
 * ownership mismatch — same as the transaction detail read: a 403 would
 * confirm a batch with that ID exists (just not theirs).
 */
export async function getSettlementBatch(
  pool: Pool,
  input: { merchantId: string; batchId: string },
): Promise<SettlementBatchDetailDto | null> {
  const batchResult = await pool.query<SettlementBatchRow>(
    `SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at
       FROM settlement_batches WHERE id = $1 AND merchant_id = $2`,
    [input.batchId, input.merchantId],
  );
  const row = batchResult.rows[0];
  if (!row) return null;

  const [txnCountResult, eventCountResult] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, [
      input.batchId,
    ]),
    pool.query<{ count: string }>(`SELECT count(*) FROM transaction_events WHERE settlement_batch_id = $1`, [
      input.batchId,
    ]),
  ]);

  return {
    ...serializeBatch(row),
    includedTransactionCount: Number(txnCountResult.rows[0]?.count ?? 0),
    includedEventCount: Number(eventCountResult.rows[0]?.count ?? 0),
  };
}

/**
 * schemeAmountFils: the amount the scheme export line carries (truncated
 * to whole 10-fils units). capturedFils: the untruncated captured total.
 */
export interface SettlementBatchTransactionDto {
  transactionId: string;
  schemeAmountFils: number;
  lineSequence: number;
  reference: string | null;
  status: string;
  authorizedFils: number;
  capturedFils: number;
}

interface SettlementBatchTransactionRow {
  transaction_id: string;
  scheme_amount_fils: string | number;
  line_sequence: number;
  reference: string | null;
  status: string;
  authorized_fils: string | number;
  captured_fils: string | number;
}

/**
 * `GET /v1/settlement/batches/:id/transactions` business logic.
 * Same 404-on-ownership-mismatch check as `getSettlementBatch`, performed
 * by the caller (routes/settlement.ts) before this is called. Reads from
 * scheme_export_lines (many, but exactly-one-per-transaction by
 * construction) joined -> transactions (one) — the safe join direction.
 */
// unbounded but a batch is one merchant one day, max a few thousand lines — am
export async function listBatchTransactions(
  pool: Pool,
  batchId: string,
): Promise<SettlementBatchTransactionDto[]> {
  const result = await pool.query<SettlementBatchTransactionRow>(
    `SELECT sel.transaction_id, sel.amount_fils AS scheme_amount_fils, sel.line_sequence,
            t.reference, t.status, t.amount_fils AS authorized_fils, t.captured_fils
       FROM scheme_export_lines sel
       JOIN transactions t ON t.id = sel.transaction_id
      WHERE sel.settlement_batch_id = $1
      ORDER BY sel.line_sequence`,
    [batchId],
  );

  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    schemeAmountFils: Number(row.scheme_amount_fils),
    lineSequence: row.line_sequence,
    reference: row.reference,
    status: row.status,
    authorizedFils: Number(row.authorized_fils),
    capturedFils: Number(row.captured_fils),
  }));
}

/**
 * gapFils = ledgerMerchantPayableNetFils - settlementNetPayoutFils -
 * pendingUnbatchedFils. Refund legs are included both in the ledger figure
 * and in pending, so a period with refunds still explains to zero.
 */
export interface ReconciliationReport {
  periodFrom: string;
  periodTo: string;
  ledgerMerchantPayableNetFils: number;
  settlementNetPayoutFils: number;
  pendingUnbatchedFils: number;
  gapFils: number;
  explained: boolean;
}

/** Fixed UTC+3 midnight for a Bahrain business-day boundary. */
function bahrainLocalMidnightUtc(dateStr: string): Date {
  const parsed = new Date(`${dateStr}T00:00:00+03:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`bahrainLocalMidnightUtc: invalid date "${dateStr}"`);
  }
  return parsed;
}

/** `GET /v1/settlement/reconciliation` business logic. */
/**
 * @param input.from  inclusive business date (YYYY-MM-DD)
 * @param input.to    exclusive business date (YYYY-MM-DD)
 * @returns explained === true iff gapFils === 0. The pending figure uses
 *          the fee each capture actually posted (event metadata.feeFils) and,
 *          for refunds, the amount and fee each refund reversed.
 */
export async function getReconciliationReport(
  pool: Pool,
  input: { merchantId: string; from: string; to: string },
): Promise<ReconciliationReport> {
  const windowStart = bahrainLocalMidnightUtc(input.from);
  const windowEnd = bahrainLocalMidnightUtc(input.to);

  const [ledgerResult, settlementResult, pendingResult, merchantResult] = await Promise.all([
    pool.query<{ net: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) AS net
         FROM ledger_entries
        WHERE merchant_id = $1 AND account_id = 'merchant_payable'
          AND occurred_at >= $2 AND occurred_at < $3`,
      [input.merchantId, windowStart, windowEnd],
    ),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(net_payout_fils), 0) AS total
         FROM settlement_batches
        WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
          AND status IN ('closed', 'paid')`,
      [input.merchantId, input.from, input.to],
    ),
    pool.query<{
      event_type: string;
      amount_fils: string | number;
      fee_fils: string | number | null;
      fee_reversed_fils: string | number;
    }>(
      `SELECT te.event_type, te.amount_fils,
              (te.metadata->>'feeFils')::bigint AS fee_fils,
              COALESCE((te.metadata->>'feeReversedFils')::bigint, 0) AS fee_reversed_fils
         FROM transaction_events te
         JOIN transactions t ON t.id = te.transaction_id
        WHERE t.merchant_id = $1
          AND te.event_type IN ('captured', 'partially_captured', 'refunded', 'refund_partial')
          AND te.settlement_batch_id IS NULL
          AND te.occurred_at >= $2 AND te.occurred_at < $3`,
      [input.merchantId, windowStart, windowEnd],
    ),
    pool.query<{ mdr_bps: number; negotiated_discount_bps: number }>(
      `SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    ),
  ]);

  // Fallback only, for capture events recorded before capture stored its fee
  // in metadata: merchants.mdr_bps is NOT synced with fee_schedules (there is
  // no such trigger), so it can differ from what was actually charged.
  const merchant = merchantResult.rows[0];
  const mdrBps = merchant?.mdr_bps ?? 0;
  const discountBps = merchant?.negotiated_discount_bps ?? 0;

  let pendingUnbatchedFils = 0;
  for (const row of pendingResult.rows) {
    const amountFils = Number(row.amount_fils);
    if (row.event_type === "refunded" || row.event_type === "refund_partial") {
      // A refund event's amount is negative; it gives back the fee it reversed.
      // Same arithmetic as CloseBatch applies when the refund is batched.
      pendingUnbatchedFils += amountFils + Number(row.fee_reversed_fils);
      continue;
    }
    // The fee capture actually posted to the ledger (metadata.feeFils), so
    // pending matches the ledger exactly; estimate only when it's missing.
    const feeFils =
      row.fee_fils === null ? estimateFeeFils(amountFils, mdrBps, discountBps) : Number(row.fee_fils);
    pendingUnbatchedFils += amountFils - feeFils;
  }

  const ledgerMerchantPayableNetFils = Number(ledgerResult.rows[0]?.net ?? 0);
  const settlementNetPayoutFils = Number(settlementResult.rows[0]?.total ?? 0);
  const gapFils = ledgerMerchantPayableNetFils - settlementNetPayoutFils - pendingUnbatchedFils;

  return {
    periodFrom: input.from,
    periodTo: input.to,
    ledgerMerchantPayableNetFils,
    settlementNetPayoutFils,
    pendingUnbatchedFils,
    gapFils,
    explained: gapFils === 0,
  };
}

export interface SettlementSummaryDto {
  periodFrom: string;
  periodTo: string;
  transactionCount: number;
  totalCapturedFils: number;
}

interface SettlementSummaryRow {
  transaction_count: string;
  total_captured_fils: string | number | null;
}

/** Gross captured in window, joined through transaction_events for batch parity. */
export async function getSettlementSummary(
  pool: Pool,
  input: { merchantId: string; from: string; to: string },
): Promise<SettlementSummaryDto> {
  const windowStart = bahrainLocalMidnightUtc(input.from);
  const windowEnd = bahrainLocalMidnightUtc(input.to);

  const result = await pool.query<SettlementSummaryRow>(
    `WITH captured AS (
       SELECT t.id, t.captured_fils
         FROM transactions t
         JOIN transaction_events te ON te.transaction_id = t.id
        WHERE t.merchant_id = $1
          AND te.event_type IN ('captured', 'partially_captured')
          AND te.occurred_at >= $2 AND te.occurred_at < $3
     )
     SELECT COUNT(DISTINCT id) AS transaction_count,
            COALESCE(SUM(captured_fils), 0) AS total_captured_fils
       FROM captured`,
    [input.merchantId, windowStart, windowEnd],
  );

  const row = result.rows[0];
  return {
    periodFrom: input.from,
    periodTo: input.to,
    transactionCount: Number(row?.transaction_count ?? 0),
    totalCapturedFils: Number(row?.total_captured_fils ?? 0),
  };
}
