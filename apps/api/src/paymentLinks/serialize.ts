/** Raw shape of a `payment_links` row as returned by `pg` (snake_case,
 *  BIGINT columns as strings). */
export interface PaymentLinkRow {
  id: string;
  merchant_id: string;
  token: string;
  amount_fils: string | number;
  currency: string;
  reference: string | null;
  description: string | null;
  status: string;
  expires_at: Date;
  reserved_at: Date | null;
  transaction_id: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: Date;
  paid_at: Date | null;
  canceled_at: Date | null;
}

/** Merchant-facing DTO (create response, list response) — the full,
 *  internal shape, including `id` (to call DELETE) and the stored
 *  status, except that a stored 'active' past expires_at reads 'expired' as it
 *  does on the public checkout (nothing writes 'expired' to the row). Never returned by the public read/pay
 *  endpoints. */
export interface PaymentLinkDto {
  id: string;
  token: string;
  url: string;
  amountFils: number;
  currency: string;
  reference: string | null;
  description: string | null;
  status: string;
  expiresAt: string;
  transactionId: string | null;
  createdAt: string;
  paidAt: string | null;
  canceledAt: string | null;
}

/** checkoutBaseUrl must not end in "/". Tokens use the base64url alphabet, so no escaping is needed. */
export function buildCheckoutUrl(checkoutBaseUrl: string, token: string): string {
  return `${checkoutBaseUrl}/pay/${token}`;
}

export function serializePaymentLink(row: PaymentLinkRow, checkoutBaseUrl: string): PaymentLinkDto {
  return {
    id: row.id,
    token: row.token,
    url: buildCheckoutUrl(checkoutBaseUrl, row.token),
    amountFils: Number(row.amount_fils),
    currency: row.currency,
    reference: row.reference,
    description: row.description,
    status: row.status === "active" && row.expires_at.getTime() <= Date.now() ? "expired" : row.status,
    expiresAt: row.expires_at.toISOString(),
    transactionId: row.transaction_id,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    canceledAt: row.canceled_at ? row.canceled_at.toISOString() : null,
  };
}
