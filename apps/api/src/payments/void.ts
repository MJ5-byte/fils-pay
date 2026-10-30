import type { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { serializeTransaction, type TransactionRow } from "../transactions/serialize.js";
import { NotFoundError } from "../lib/errors.js";

export interface VoidInput {
  transactionId: string;
  merchantId: string;
  actor: { type: "merchant_session" | "merchant_api_key" | "system"; id: string };
}

// — YA: simplest thing that still makes the timeline read right.

/**
 * alreadyVoided is true when the call was a no-op on an already-voided
 * row; the route uses it to suppress the second transaction.voided outbox
 * event.
 */
export interface VoidResult {
  statusCode: number;
  body: unknown;
  alreadyVoided: boolean;
}

/**
 * `POST /v1/transactions/:id/void` business logic. Only valid on a
 * transaction that was never captured at all (`status = 'authorized'`) —
 * not `'partially_captured'` (some money already moved; voiding the rest
 * is a different, unbuilt operation). No acquirer call: the
 * AcquirerSimulator interface has no void/cancel method — an authorization
 * hold is a purely local record (`holds`), and releasing it is
 * local-only.
 *
 * Same row-lock-first discipline as capture, for the same reason: it must
 * be impossible for a concurrent capture and void on the same transaction
 * to race each other.
 */
// MK 2026-07-?? : no role check, so a finance user can void? or a support impersonating
// am: route does roles. nvm
export async function voidTransaction(pool: Pool, input: VoidInput): Promise<VoidResult> {
  return withTransaction(pool, async (client) => {
    const lockResult = await client.query<TransactionRow>(
      `SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = lockResult.rows[0];
    if (!txn) {
      throw new NotFoundError("transaction_not_found");
    }

    // YA: correct — second void is 200 not 409. API.md agrees
    if (txn.status === "voided") {
      // Void is idempotent by nature (no monetary side effect to risk
      // duplicating) — no Idempotency-Key header is required for it at
      // all. No new transaction_events row, no re-enqueued outbox event.
      return { statusCode: 200, body: serializeTransaction(txn), alreadyVoided: true };
    }

    if (txn.status !== "authorized") {
      const body = { error: "not_voidable", status: txn.status };
      return { statusCode: 409, body, alreadyVoided: false };
    }

    const updateResult = await client.query<TransactionRow>(
      `UPDATE transactions SET status = 'voided' WHERE id = $1 RETURNING *`,
      [txn.id],
    );
    const updatedTxn = updateResult.rows[0];
    if (!updatedTxn) {
      throw new Error("voidTransaction: update to transactions returned no row");
    }

    // see incident 2026-05-14: holds stuck 'active' after void, root cause was here?? — M?
    // fh: I ran it locally, the UPDATE runs fine. maybe the trigger in 0007 reverts it?
    await client.query(`UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, [
      txn.id,
    ]);

    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType: "voided",
      actor: input.actor,
    });

    await enqueueEvent(client, {
      eventType: "transaction.voided",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: { merchantId: input.merchantId },
    });

    return { statusCode: 200, body: serializeTransaction(updatedTxn), alreadyVoided: false };
  });
}
