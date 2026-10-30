import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import { hashRequest } from "../payments/idempotency.js";
import { sha256Hex } from "../lib/crypto.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}
export interface PayPaymentLinkResult { statusCode: number; body: unknown }
interface LinkRow {
  id: string; merchant_id: string; amount_fils: string; reference: string | null;
  status: string; expires_at: Date; paid_at: Date | null; transaction_id: string | null;
  reservation_id: string | null; payment_key_hash: string | null; payment_request_hash: string | null;
}

/** Public checkout only trusts the server clock; submittedAt is untrusted. */
export function expiryReferenceTime(_submittedAt?: string): Date { return new Date(); }

/**
 * A durable claim binds the link to one payer's key and request before any
 * acquirer operation. Timeout permits only that same request to resume.
 * Authorize/capture use their existing persistent idempotency records, so
 * retries across any committed phase reuse the transaction and capture.
 * No transaction or payment-link row lock spans the external calls.
 */
export async function payPaymentLink(
  pool: Pool, acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number }, input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const keyHash = sha256Hex(input.idempotencyKey);
  const requestHash = hashRequest({ card: input.card });
  const reservationId = randomUUID();
  const claimed = await pool.query<LinkRow>(
    `UPDATE payment_links SET status = 'reserved', reserved_at = now(), reservation_id = $2,
        payment_key_hash = $3, payment_request_hash = $4
      WHERE token = $1 AND (
        (status = 'active' AND expires_at > now()) OR
        (status = 'reserved' AND payment_key_hash = $3 AND payment_request_hash = $4
          AND reserved_at < now() - make_interval(secs => $5::int)))
      RETURNING *`,
    [input.token, reservationId, keyHash, requestHash, config.paymentLinkReservationTimeoutSeconds],
  );
  const link = claimed.rows[0];
  if (!link) {
    const current = (await pool.query<LinkRow>(`SELECT * FROM payment_links WHERE token = $1`, [input.token])).rows[0];
    if (!current) return { statusCode: 404, body: { error: "payment_link_not_found" } };
    if (current.payment_key_hash === keyHash && current.payment_request_hash !== requestHash) {
      return { statusCode: 422, body: { error: "idempotency_key_reused" } };
    }
    if (current.status === "paid") {
      if (current.payment_key_hash === keyHash) return paidResponse(current);
      return { statusCode: 409, body: { error: "payment_link_already_paid" } };
    }
    if (current.status === "canceled") return { statusCode: 409, body: { error: "payment_link_canceled" } };
    if (current.status === "active" && current.expires_at.getTime() <= Date.now()) {
      return { statusCode: 410, body: { error: "payment_link_expired" } };
    }
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }

  const auth = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchant_id, amountFils: toFils(Number(link.amount_fils)), card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: `paylink:${link.id}:${input.idempotencyKey}:authorize`, actor: { type: "system" },
  });
  if (auth.statusCode !== 201) {
    // A transport failure is ambiguous; retain the binding for same-key recovery.
    if (auth.statusCode < 500) await releaseReservation(pool, link.id, reservationId);
    return { statusCode: auth.statusCode, body: { stage: "authorize", ...auth.body as object } };
  }
  const transactionId = (auth.body as { id: string }).id;
  const capture = await captureTransaction(pool, acquirer, {
    transactionId, merchantId: link.merchant_id,
    idempotencyKey: `paylink:${link.id}:${input.idempotencyKey}:capture`, actor: { type: "system", id: link.id },
  });
  if (capture.statusCode !== 200) {
    if (capture.statusCode === 402) {
      // Definitive decline: release the local simulator hold before admitting
      // another payer. Unknown outcomes stay bound for retry/reconciliation.
      const voided = await voidTransaction(pool, { transactionId, merchantId: link.merchant_id, actor: { type: "system", id: link.id } });
      if (voided.statusCode === 200) await releaseReservation(pool, link.id, reservationId);
    }
    return { statusCode: capture.statusCode, body: { stage: "capture", ...capture.body as object } };
  }
  await applyCaptureDiscountAdjustment(pool, { merchantId: link.merchant_id, transactionId });
  const finalized = await pool.query<LinkRow>(
    `UPDATE payment_links SET status = 'paid', paid_at = now(), transaction_id = $2,
        reserved_at = NULL, reservation_id = NULL
      WHERE id = $1 AND status = 'reserved' AND payment_key_hash = $3 AND payment_request_hash = $4
      RETURNING *`, [link.id, transactionId, keyHash, requestHash],
  );
  if (finalized.rows[0]) return paidResponse(finalized.rows[0]);
  const paid = (await pool.query<LinkRow>(`SELECT * FROM payment_links WHERE id = $1 AND status = 'paid' AND transaction_id = $2`, [link.id, transactionId])).rows[0];
  if (paid) return paidResponse(paid);
  throw new Error(`Payment link finalization lost after capture: ${link.id}/${transactionId}`);
}
function paidResponse(link: LinkRow): PayPaymentLinkResult {
  return { statusCode: 200, body: { status: "paid", transactionId: link.transaction_id,
    amountFils: toFils(Number(link.amount_fils)), paidAt: link.paid_at!.toISOString() } };
}
async function releaseReservation(pool: Pool, id: string, reservationId: string): Promise<void> {
  await pool.query(`UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL,
    payment_key_hash = NULL, payment_request_hash = NULL WHERE id = $1 AND status = 'reserved' AND reservation_id = $2`, [id, reservationId]);
}
