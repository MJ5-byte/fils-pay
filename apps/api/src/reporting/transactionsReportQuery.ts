import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/**
 * Report predicate. `merchantId` is always overwritten by the route with the
 * authenticated merchant before this reaches runTransactionsReport, so a
 * value supplied in the saved filter body is ignored. `limit` and `cursor`
 * are pagination, set by the route from the query string, never from the
 * saved filter body.
 */
export interface TransactionReportFilter {
  merchantId: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
}

/** Money is pre-formatted as BD strings with 3 decimals (formatBhd), unlike the rest of the API which returns fils. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  reference: string | null;
  occurredAt: string;
}

export interface TransactionReportResult {
  transactions: TransactionReportRow[];
  nextCursor: string | null;
}

interface TransactionReportQueryRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  reference: string | null;
  occurred_at: Date;
  occurred_at_text: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface DecodedCursor {
  occurredAt: string;
  id: string;
}

/** Cursor = base64url("<occurred_at as printed by Postgres>|<id>"); see encodeCursor. */
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
  const occurredAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!occurredAt || !id) return null;
  return { occurredAt, id };
}

/**
 * Encodes the cursor from Postgres's own text rendering of `occurred_at`,
 * never `Date.toISOString()` (millisecond precision). `timestamptz` has
 * microsecond precision, and two rows can share a millisecond. Round-
 * tripping the value Postgres printed keeps the keyset exact, matching
 * transactions/query.ts listTransactions.
 */
function encodeCursor(occurredAtText: string, id: string): string {
  return Buffer.from(`${occurredAtText}|${id}`, "utf8").toString("base64url");
}

/**
 * Keyset pagination on `(occurred_at DESC, id DESC)`, the same pattern as
 * transactions/query.ts listTransactions. The previous query hard-capped at
 * `LIMIT 500` with no cursor, so a merchant with more than 500 matching rows
 * silently lost every row past the first 500. A bounded page plus a
 * `nextCursor` lets the caller read the whole result set and signals when
 * more remains instead of dropping rows in silence.
 */
export async function runTransactionsReport(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<TransactionReportResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, filter.limit ?? DEFAULT_LIMIT));
  const decodedCursor = decodeCursor(filter.cursor);
  // A present cursor that cannot be decoded must not fall back to page one:
  // a client looping on nextCursor would re-read the first page forever.
  if (filter.cursor && !decodedCursor) {
    throw new BadRequestError("invalid_cursor", "cursor is not valid");
  }

  const params: unknown[] = [filter.merchantId];
  const conditions: string[] = ["merchant_id = $1"];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    conditions.push(`occurred_at < $${params.length}`);
  }
  params.push(decodedCursor?.occurredAt ?? null);
  const cursorTsParam = params.length;
  params.push(decodedCursor?.id ?? null);
  const cursorIdParam = params.length;
  conditions.push(
    `($${cursorTsParam}::timestamptz IS NULL OR (occurred_at, id) < ($${cursorTsParam}, $${cursorIdParam}))`,
  );
  params.push(limit);
  const limitParam = params.length;

  const result = await pool
    .query<TransactionReportQueryRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, reference, occurred_at,
              occurred_at::text AS occurred_at_text
         FROM transactions
        WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${limitParam}`,
      params,
    )
    .catch((err: unknown) => {
      // SQLSTATE class 22 with a cursor present: the decoded cursor isn't a valid timestamp/uuid.
      if (decodedCursor && (err as { code?: string }).code?.startsWith("22")) {
        throw new BadRequestError("invalid_cursor", "cursor is not valid");
      }
      throw err;
    });

  const transactions = result.rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountBhd: formatBhd(toFils(Number(row.amount_fils))),
    capturedBhd: formatBhd(toFils(Number(row.captured_fils))),
    reference: row.reference,
    occurredAt: row.occurred_at.toISOString(),
  }));
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.occurred_at_text, lastRow.id) : null;

  return { transactions, nextCursor };
}
