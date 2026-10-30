/** Raw shape of a `transactions` row as returned by `pg` (snake_case,
 *  BIGINT columns as strings). */
export interface TransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  currency: string;
  reference: string | null;
  acquirer_reference: string;
  occurred_at: Date;
  created_at: Date;
}

/**
 * Public transaction shape. `amountFils` is the authorized amount and
 * `capturedFils` the cumulative captured amount, `refundedFils` the
 * cumulative refunded amount; the refundable balance is
 * capturedFils - refundedFils.
 */
export interface TransactionDto {
  id: string;
  merchantId: string;
  status: string;
  amountFils: number;
  capturedFils: number;
  refundedFils: number;
  currency: string;
  reference: string | null;
  acquirerReference: string;
  occurredAt: string;
  createdAt: string;
}

/** The single place a `transactions` row is turned into its camelCase,
 *  JSON-serializable API shape — used by authorize/capture/void and the
 *  read endpoints alike, so the response shape can't drift between them. */
export function serializeTransaction(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountFils: Number(row.amount_fils),
    capturedFils: Number(row.captured_fils),
    refundedFils: Number(row.refunded_fils),
    currency: row.currency,
    reference: row.reference,
    acquirerReference: row.acquirer_reference,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
