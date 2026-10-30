/**
 * Derived public status for a payment link — computed identically by
 * GET /v1/payment-links/:token (read.ts) and by the pay endpoint's
 * claim-failure classification (pay.ts), from one shared helper, so the
 * two endpoints can never disagree about what state a link is "really" in.
 *
 * Deliberately narrower than the stored `payment_links.status` enum: a
 * customer-facing checkout page never needs to distinguish a live 'active'
 * link from one whose reservation has already self-expired back to
 * claimable — both are simply 'active' from the outside. A merchant-facing
 * list (query.ts, serialize.ts) uses the stored status instead (except a stored 'active' past expires_at, which reads 'expired'), since a dashboard
 * operator does benefit from seeing "a payment is currently in flight" as
 * its own filterable state.
 */
export type PublicPaymentLinkStatus = "active" | "processing" | "paid" | "expired" | "canceled";

/** reservedAt null on a 'reserved' row is treated as epoch, i.e. immediately claimable again. */
export interface PaymentLinkStatusInput {
  status: string;
  expiresAt: Date;
  reservedAt: Date | null;
}

// FH: uses Date.now() not the client time — should this use expiryReferenceTime too?
// MK: no. public status is server time. (and yes that means read/pay can disagree, known)
export function derivePublicStatus(
  row: PaymentLinkStatusInput,
  reservationTimeoutSeconds: number,
): PublicPaymentLinkStatus {
  if (row.status === "paid") return "paid";
  if (row.status === "canceled") return "canceled";

  if (row.status === "active") {
    return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
  }

  // row.status === 'reserved'
  const reservedAtMs = row.reservedAt?.getTime() ?? 0;
  const stillReserved = reservedAtMs > Date.now() - reservationTimeoutSeconds * 1000;
  return stillReserved ? "processing" : row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}
