import type { Pool } from "pg";
import { NotFoundError } from "../lib/errors.js";

/** @property outcome Validated against the two allowed values by the route schema. */
export interface AcquirerCallbackInput {
  callbackId: string;
  type: "fraud_review.completed";
  transactionId: string;
  occurredAt: string;
  outcome: "cleared" | "confirmed_fraud";
  note: string;
}

interface TransactionMerchantRow {
  merchant_id: string;
}

/**
 * Applies one acquirer callback: looks up the transaction it refers to and
 * appends a note recording the acquirer's own delayed verdict.
 * acquirer_callback_notes is append-only and surfaced on the transaction
 * timeline for support/finance to read — a fraud-review verdict is
 * informational, not a state transition, so this never touches
 * transactions.status or the ledger; a confirmed-fraud outcome still needs
 * a human decision to void/refund, exactly as today.
 *
 * Idempotent per (transaction_id, callback_id): a redelivery inserts
 * nothing (FP-201). Returns whether a NEW row was inserted.
 */
export async function applyAcquirerCallback(pool: Pool, callback: AcquirerCallbackInput): Promise<boolean> {
  const txnResult = await pool.query<TransactionMerchantRow>(
    `SELECT merchant_id FROM transactions WHERE id = $1`,
    [callback.transactionId],
  );
  const txnRow = txnResult.rows[0];
  if (!txnRow) {
    throw new NotFoundError("transaction_not_found");
  }

  const result = await pool.query(
    `INSERT INTO acquirer_callback_notes
        (transaction_id, merchant_id, callback_id, callback_type, outcome, note, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (transaction_id, callback_id) DO NOTHING`,
    [
      callback.transactionId,
      txnRow.merchant_id,
      callback.callbackId,
      callback.type,
      callback.outcome,
      callback.note,
    ],
  );
  // A redelivered verdict (same transaction, same callback_id) is a no-op:
  // FP-201. The unique index is 0073; the pair is the dedup scope, never
  // callback_id alone, because the sandbox acquirer reuses callback_ids
  // across transactions.
  return (result.rowCount ?? 0) > 0;
}

/**
 * Defaults: 3 attempts, 50 ms apart.
 * — FH
 */
export interface CallbackRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

export async function withCallbackRetry<T>(fn: () => Promise<T>, options: CallbackRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 50;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}
