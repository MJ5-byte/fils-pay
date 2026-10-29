import type { Pool } from "pg";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/**
 * Cancels an active payment link by id, scoped to the calling merchant — a
 * link that exists but belongs to another merchant is indistinguishable
 * from a missing one (not_found), so a merchant can never cancel (or even
 * learn the status of) a link they do not own. (B13)
 */
export async function cancelPaymentLink(
  pool: Pool,
  input: { id: string; merchantId: string },
): Promise<CancelPaymentLinkResult> {
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now()
      WHERE id = $1 AND merchant_id = $2 AND status = 'active'
      RETURNING id`,
    [input.id, input.merchantId],
  );
  if (updateResult.rows[0]) {
    return { outcome: "canceled" };
  }

  // YA: second read is just for the error shape, no race. fine
  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}
