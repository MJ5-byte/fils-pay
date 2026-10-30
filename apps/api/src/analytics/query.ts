import type { Pool } from "pg";
import { BadRequestError } from "../lib/errors.js";

const DEFAULT_TOP_LINKS_LIMIT = 10;
const MIN_TOP_LINKS_LIMIT = 1;
const MAX_TOP_LINKS_LIMIT = 50;

/**
 * Clamps a client-supplied "how many" value to [1, 50], defaulting to 10 —
 * the ONLY "how many" parameter top-links accepts. A value outside the range is silently clamped, never trusted past
 * the cap; a non-finite/garbage value falls back to the default.
 */
export function clampTopLinksLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) return DEFAULT_TOP_LINKS_LIMIT;
  return Math.min(MAX_TOP_LINKS_LIMIT, Math.max(MIN_TOP_LINKS_LIMIT, Math.trunc(rawLimit)));
}

const ALLOWED_BREAKDOWN_COLUMNS: Record<string, string> = {
  status: "t.status",
  day: "(t.created_at AT TIME ZONE 'Asia/Bahrain')::date",
};

export async function getBreakdown(
  pool: Pool,
  input: { merchantId: string; from: string; to: string; groupBy: string },
): Promise<{ rows: Array<{ group: string; count: number; totalFils: number }> }> {
  const col = ALLOWED_BREAKDOWN_COLUMNS[input.groupBy];
  if (!col) throw new Error(`getBreakdown: invalid groupBy "${input.groupBy}"`);

  const result = await pool.query<{ grp: string; cnt: string; total: string }>(
    `SELECT ${col} AS grp, COUNT(*)::text AS cnt, COALESCE(SUM(amount_fils), 0)::text AS total
       FROM transactions t
      WHERE t.merchant_id = $1 AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
      GROUP BY ${col}
      ORDER BY total DESC`,
    [input.merchantId, input.from, input.to],
  );
  return {
    rows: result.rows.map((r) => ({
      group: String(r.grp),
      count: Number(r.cnt),
      totalFils: Number(r.total),
    })),
  };
}

export interface VolumePointDto {
  date: string;
  capturedCount: number;
  capturedGrossFils: number;
  voidedCount: number;
}

export interface VolumesResponse {
  points: VolumePointDto[];
  /** Sourced from reporting_outbox_cursor.updated_at — the single watermark
   *  timestamp answering "as of when has every rollup this response reads
   *  from been fully brought up to date". `null` only if apps/reporting's
   *  worker has never completed a pass against this database (a brand-new
   *  deployment, before the first pass runs). */
  readModelAsOf: string | null;
  live: boolean;
}

interface VolumeRow {
  volume_date: Date;
  captured_count: number;
  captured_gross_fils: string | number;
  voided_count: number;
}

interface CursorRow {
  updated_at: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** A DATE column value, read back by `pg` using the process's local
 *  timezone (not UTC) — reading the Date's own local year/month/day
 *  getters avoids the same off-by-one-day risk
 *  apps/api/src/settlement/query.ts's `toBatchDateString` documents. */
function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function serializeVolumePoint(row: VolumeRow): VolumePointDto {
  return {
    date: toDateString(row.volume_date),
    capturedCount: row.captured_count,
    capturedGrossFils: Number(row.captured_gross_fils),
    voidedCount: row.voided_count,
  };
}

async function readModelAsOf(pool: Pool): Promise<string | null> {
  const cursorResult = await pool.query<CursorRow>(
    `SELECT updated_at FROM reporting_outbox_cursor WHERE consumer_name = 'reporting'`,
  );
  return cursorResult.rows[0]?.updated_at.toISOString() ?? null;
}

/**
 * `GET /v1/analytics/volumes` business logic. Every
 * predicate is a fixed, parameterized comparison against a caller-validated
 * `from`/`to` (YYYY-MM-DD strings, `to` exclusive) — never a client-supplied
 * filter object or raw SQL fragment.
 * `merchantId` must always be `request.merchantAuth.merchantId`, never a
 * path/query value — enforced by the caller (routes/analytics.ts).
 */
export async function getVolumes(
  pool: Pool,
  input: { merchantId: string; from: string; to: string },
): Promise<VolumesResponse> {
  const [pointsResult, asOf] = await Promise.all([
    pool.query<VolumeRow>(
      `SELECT volume_date, captured_count, captured_gross_fils, voided_count
         FROM merchant_daily_volume
        WHERE merchant_id = $1 AND volume_date >= $2 AND volume_date < $3
        ORDER BY volume_date ASC`,
      [input.merchantId, input.from, input.to],
    ),
    readModelAsOf(pool),
  ]);

  return {
    points: pointsResult.rows.map(serializeVolumePoint),
    readModelAsOf: asOf,
    live: false,
  };
}

export interface PayoutTrendPointDto {
  settlementBatchId: string;
  batchDate: string;
  status: string;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
  paidAt: string | null;
}

export interface PayoutTrendsResponse {
  points: PayoutTrendPointDto[];
  readModelAsOf: string | null;
  live: boolean;
}

interface PayoutTrendRow {
  settlement_batch_id: string;
  batch_date: Date;
  status: string;
  gross_fils: string | number;
  fee_fils: string | number;
  net_payout_fils: string | number;
  paid_at: Date | null;
}

function serializePayoutTrendPoint(row: PayoutTrendRow): PayoutTrendPointDto {
  return {
    settlementBatchId: row.settlement_batch_id,
    batchDate: toDateString(row.batch_date),
    status: row.status,
    grossFils: Number(row.gross_fils),
    feeFils: Number(row.fee_fils),
    netPayoutFils: Number(row.net_payout_fils),
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

/**
 * `GET /v1/analytics/payout-trends` business logic. Same
 * `from`/`to` validation/defaulting discipline as `getVolumes`, applied to
 * `batch_date`. `readModelAsOf` is sourced from the same
 * reporting_outbox_cursor row as `getVolumes` — one shared freshness signal
 * across every reporting-maintained widget.
 */
export async function getPayoutTrends(
  pool: Pool,
  input: { merchantId: string; from: string; to: string },
): Promise<PayoutTrendsResponse> {
  const [pointsResult, asOf] = await Promise.all([
    pool.query<PayoutTrendRow>(
      `SELECT settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at
         FROM merchant_payout_trends
        WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
        ORDER BY batch_date ASC`,
      [input.merchantId, input.from, input.to],
    ),
    readModelAsOf(pool),
  ]);

  return {
    points: pointsResult.rows.map(serializePayoutTrendPoint),
    readModelAsOf: asOf,
    live: false,
  };
}

export interface TopLinkDto {
  id: string;
  reference: string | null;
  description: string | null;
  amountFils: number;
  paidAt: string;
}

export interface TopLinksResponse {
  links: TopLinkDto[];
  readModelAsOf: string;
  live: true;
}

interface TopLinkRow {
  id: string;
  reference: string | null;
  description: string | null;
  amount_fils: string | number;
  paid_at: Date;
}

/**
 * `GET /v1/analytics/top-links` business logic — the live exception. No
 * rollup table: reads `payment_links` directly, live, on every request
 * (payment links are single-use, so this query is
 * inherently narrow and already indexed — see 0029's partial index). Its
 * `readModelAsOf` is simply the request-handling instant, with `live: true`,
 * so this widget never needs a null-check the other two lagged widgets do.
 *
 * `limit` is already clamped to [1, 50] by the caller via
 * `clampTopLinksLimit` before reaching here — this is the endpoint's only
 * "how many" parameter; there is no `sort`, `filter`, or raw predicate
 * parameter of any kind.
 */
export async function getTopLinks(
  pool: Pool,
  input: { merchantId: string; fromInstant: Date; toInstant: Date; limit: number },
): Promise<TopLinksResponse> {
  const result = await pool.query<TopLinkRow>(
    `SELECT id, reference, description, amount_fils, paid_at
       FROM payment_links
      WHERE merchant_id = $1 AND status = 'paid'
        AND paid_at >= $2 AND paid_at < $3
      ORDER BY amount_fils DESC, paid_at DESC
      LIMIT $4`,
    [input.merchantId, input.fromInstant, input.toInstant, input.limit],
  );

  return {
    links: result.rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      description: row.description,
      amountFils: Number(row.amount_fils),
      paidAt: row.paid_at.toISOString(),
    })),
    readModelAsOf: new Date().toISOString(),
    live: true,
  };
}

export interface LedgerActivityPointDto {
  id: string;
  accountId: string;
  direction: "debit" | "credit";
  amountFils: number;
  occurredAt: string;
  description: string | null;
}

export interface RecentLedgerActivityResponse {
  points: LedgerActivityPointDto[];
  nextCursor: string | null;
  readModelAsOf: string;
  live: true;
}

interface LedgerActivityRow {
  id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_fils: string | number;
  occurred_at: Date;
  occurred_at_text: string;
  description: string | null;
}

const LEDGER_ACTIVITY_PAGE_SIZE = 200;

/** Cursor = base64url("<occurred_at as printed by Postgres>|<id>"), the same
 *  keyset as reporting/transactionsReportQuery.ts (microsecond-exact). */
function decodeLedgerCursor(cursor: string): { occurredAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separatorIndex = decoded.indexOf("|");
  const occurredAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (separatorIndex === -1 || !occurredAt || !id) {
    throw new BadRequestError("invalid_cursor", "cursor is not valid");
  }
  return { occurredAt, id };
}

/**
 * `GET /v1/analytics/recent-ledger-activity` business logic. The second
 * "live exception" widget alongside `getTopLinks` — merchants asked for
 * activity that's visible the moment it posts, not lagged behind
 * apps/reporting's rollup cadence the way `getVolumes`/`getPayoutTrends`
 * are (this bypasses the rollups entirely, on purpose, same as
 * `getTopLinks`).
 *
 * `from`/`to` are Bahrain business-date strings (YYYY-MM-DD), matched against
 * `occurred_at` in Bahrain local calendar terms — Bahrain observes no DST
 * (fixed UTC+3 since 1972), so this reduces to a `date` comparison per row.
 * The window is half-open `[from, to)`: `to` is exclusive, the same
 * convention `parseDateRange`, `getVolumes` and `getTopLinks` already use,
 * so a boundary day is counted in exactly one window, never both.
 */
export async function getRecentLedgerActivity(
  pool: Pool,
  input: { merchantId: string; from: string; to: string; cursor?: string | null },
): Promise<RecentLedgerActivityResponse> {
  // A present cursor that cannot be decoded must not fall back to page one.
  const after = input.cursor ? decodeLedgerCursor(input.cursor) : null;
  const result = await pool
    .query<LedgerActivityRow>(
      `SELECT id, account_id, direction, amount_fils, occurred_at, description,
              occurred_at::text AS occurred_at_text
         FROM ledger_entries
        WHERE merchant_id = $1
          AND (occurred_at AT TIME ZONE 'Asia/Bahrain')::date >= $2::date
          AND (occurred_at AT TIME ZONE 'Asia/Bahrain')::date < $3::date
          AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4::timestamptz, $5::bigint))
        ORDER BY occurred_at DESC, id DESC
        LIMIT $6`,
      [input.merchantId, input.from, input.to, after?.occurredAt ?? null, after?.id ?? null, LEDGER_ACTIVITY_PAGE_SIZE],
    )
    .catch((err: unknown) => {
      // SQLSTATE class 22 with a cursor present: the decoded cursor isn't a valid timestamp/bigint.
      if (after && (err as { code?: string }).code?.startsWith("22")) {
        throw new BadRequestError("invalid_cursor", "cursor is not valid");
      }
      throw err;
    });
  const lastRow = result.rows[result.rows.length - 1];

  return {
    points: result.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      direction: row.direction,
      amountFils: Number(row.amount_fils),
      occurredAt: row.occurred_at.toISOString(),
      description: row.description,
    })),
    nextCursor:
      result.rows.length === LEDGER_ACTIVITY_PAGE_SIZE && lastRow
        ? Buffer.from(`${lastRow.occurred_at_text}|${lastRow.id}`, "utf8").toString("base64url")
        : null,
    readModelAsOf: new Date().toISOString(),
    live: true,
  };
}
