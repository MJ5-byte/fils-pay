import type { Pool } from "pg";
import { serializePaymentLink, type PaymentLinkDto, type PaymentLinkRow } from "./serialize.js";

export interface ListPaymentLinksFilters {
  merchantId: string;
  status?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListPaymentLinksResult {
  paymentLinks: PaymentLinkDto[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface DecodedCursor {
  createdAt: string;
  id: string;
}

/** Any malformed cursor decodes to null, which restarts from the first page instead of erroring. */
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
  const createdAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

/**
 * Encodes the cursor from Postgres's own text rendering of `created_at`,
 * never `Date.toISOString()` (millisecond precision) — `timestamptz` has
 * microsecond precision, and two rows can share a millisecond. Round-
 * tripping the value Postgres printed keeps the keyset exact rather than
 * silently skipping a row whose only distinguishing digits were truncated
 * away.
 */
// YA: DO NOT change to toISOString, microsecond keyset. learned the hard way Dec 2025
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

/**
 * `listPaymentLinks(pool, { merchantId, ...filters })` — the same function
 * the HTTP route calls, reusable by an admin-plane read path exactly as
 * `listTransactions` is. Keyset pagination (correct under concurrent
 * inserts), backed by idx_payment_links_merchant_created.
 */
export async function listPaymentLinks(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  filters: ListPaymentLinksFilters,
): Promise<ListPaymentLinksResult> {
  // am: limit=0 -> 1? fine
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeCursor(filters.cursor);

  const result = await pool.query<PaymentLinkRow & { created_at_text: string }>(
    `SELECT *, created_at::text AS created_at_text FROM payment_links
      WHERE merchant_id = $1
        AND ($2::text[] IS NULL OR CASE WHEN status = 'active' AND expires_at <= now() THEN 'expired' ELSE status END = ANY($2))
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [filters.merchantId, statusArray, decodedCursor?.createdAt ?? null, decodedCursor?.id ?? null, limit],
  );

  const paymentLinks = result.rows.map((row) => serializePaymentLink(row, config.checkoutBaseUrl));
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { paymentLinks, nextCursor };
}

/** One of a merchant's own links by id, whatever its age; null when it is not theirs. */
export async function getMerchantPaymentLink(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  merchantId: string,
  id: string,
): Promise<PaymentLinkDto | null> {
  const result = await pool.query<PaymentLinkRow>(
    "SELECT * FROM payment_links WHERE id = $1 AND merchant_id = $2",
    [id, merchantId],
  );
  const row = result.rows[0];
  return row ? serializePaymentLink(row, config.checkoutBaseUrl) : null;
}
