import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/** Ledger description of the negotiated-discount leg (see discountAdjustment.ts). */
const DISCOUNT_ADJUSTMENT_DESCRIPTION = "capture: negotiated discount adjustment";

/** BEGIN/COMMIT on a client the caller already holds (unlike withTransaction, which checks one out). */
async function inTransaction<T>(client: PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Refund business logic: validate, call the acquirer, then journal the reversal.
 *
 * Refunds on one transaction are serialised with a session advisory lock held
 * across all three steps, including the acquirer call. Without it, two
 * refunds with different idempotency keys can both pass validation against
 * the same `refunded_fils` and together return more than was captured.
 * Both database steps run on the same connection that holds the lock, so a
 * refund never needs a second pooled connection while it waits.
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const lockKey = `refunds:${input.transactionId}`;
  const client = await pool.connect();
  let unlockError: Error | undefined;
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    try {
      return await processRefundLocked(client, acquirer, input);
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
      } catch (err) {
        // A connection that still holds the lock must not go back to the pool.
        unlockError = err instanceof Error ? err : new Error(String(err));
      }
    }
  } finally {
    client.release(unlockError);
  }
}

async function processRefundLocked(
  conn: PoolClient,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  // 1 validate
  const prepared = await inTransaction(conn, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return {
        kind: "settled" as const,
        result: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody },
      };
    }

    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    // Another merchant's transaction is indistinguishable from a missing one.
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "settled" as const, result: { statusCode: 404, body } };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // Only captured money can go back. The authorized amount is a ceiling on
    // capture, not on refund: on a partial capture it would let a merchant
    // refund money the cardholder was never charged.
    const pendingAmounts = await client.query<{ pending: string }>(
      `SELECT COALESCE(SUM(amount_fils), 0)::text AS pending FROM refunds WHERE transaction_id = $1 AND status = 'pending'`, [txn.id]);
    const refundableFils = subtractFils(subtractFils(capturedFils, refundedFils), toFils(Number(pendingAmounts.rows[0]!.pending)));

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { kind: "settled" as const, result: { statusCode, body: validation } };
    }

    // The fee this transaction was actually charged at capture, read from
    // the ledger rather than recomputed from the merchant's current
    // mdr_bps, so a rate change after capture can never retroactively alter
    // what a refund reverses. A negotiated discount is posted after capture
    // as a debit against the fee, so the fee actually charged is the capture
    // credits minus those discount debits. Earlier refunds' fee reversals are
    // deliberately excluded: calculateRefundFee pro-rates against the full
    // capture-time fee.
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND (direction = 'credit' OR description = $2)`,
      [txn.id, DISCOUNT_ADJUSTMENT_DESCRIPTION],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    const reservation = await client.query<{ id: string }>(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, status, acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7) RETURNING id`,
      [txn.id, txn.merchant_id, validation.amountFils, txn.acquirer_reference, input.reason ?? "unspecified", input.actor.type, input.actor.id]);
    return {
      kind: "proceed" as const,
      refundId: reservation.rows[0]!.id,
      claimId: claim.row.id,
      attemptCount: claim.row.attemptCount,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      acquirerReference: txn.acquirer_reference,
      amountAuthorized,
      capturedFils,
      refundedFils,
      feeChargedFils: toFils(Number(feeRow.fee_fils)),
      requestedAmount: validation.amountFils,
    };
  });

  if (prepared.kind === "settled") {
    return prepared.result;
  }

  // 2 acquirer
  const acquirerResult = await acquirer.refund({
    acquirerReference: prepared.acquirerReference,
    amountFils: prepared.requestedAmount,
    idempotencyKey: `${prepared.claimId}:${prepared.attemptCount}`,
  });

  // 3 journal
  return inTransaction(conn, async (client) => {
    if (acquirerResult.outcome === "declined" || acquirerResult.outcome === "error") {
      // The simulator's explicit negative outcome has no monetary effect;
      // thrown/unknown results retain the reservation for reconciliation.
      await client.query(`DELETE FROM refunds WHERE id = $1 AND status = 'pending'`, [prepared.refundId]);
    }
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    // Re-read under a row lock rather than trusting step 1's snapshot: a
    // capture can land during the acquirer call. The running total, the
    // status and the event type use these current figures; the fee
    // reversal below stays on step 1's snapshot (the fee charged for the
    // captures this refund was validated against).
    const current = await client.query<{ refunded_fils: string | number; captured_fils: string | number }>(
      `SELECT refunded_fils, captured_fils FROM transactions WHERE id = $1 FOR UPDATE`,
      [prepared.transactionId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) {
      throw new Error("processRefund: transaction disappeared between validate and journal");
    }
    const currentCapturedFils = toFils(Number(currentRow.captured_fils));
    const newRefundedTotal = addFils(toFils(Number(currentRow.refunded_fils)), prepared.requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: currentCapturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    // Each partial reversal is rounded on its own, so on their own they can
    // fall short of the fee charged (250 fils refunded as 3333+3333+3334 of
    // 10000 reverses 83+83+83 = 249). Cap every reversal at the fee not yet
    // reversed, and when this refund returns everything captured, reverse
    // exactly that remainder so the reversals sum to the fee to the fil.
    const reversedResult = await client.query<{ reversed: string }>(
      `SELECT COALESCE(SUM(fee_reversed_fils), 0)::text AS reversed
         FROM refunds
        WHERE transaction_id = $1 AND status = 'succeeded'`,
      [prepared.transactionId],
    );
    const feeNotYetReversed = subtractFils(
      prepared.feeChargedFils,
      toFils(Number(reversedResult.rows[0]?.reversed ?? 0)),
    );
    const remainingFee = compareFils(feeNotYetReversed, ZERO_FILS) > 0 ? feeNotYetReversed : ZERO_FILS;
    const proRata = calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, prepared.requestedAmount);
    const feeReversedFils =
      compareFils(newRefundedTotal, prepared.capturedFils) >= 0 || compareFils(proRata, remainingFee) > 0
        ? remainingFee
        : proRata;

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `UPDATE refunds SET fee_reversed_fils = $2, status = 'succeeded', acquirer_reference = $3, occurred_at = now()
        WHERE id = $1 AND status = 'pending'
       RETURNING id, occurred_at`,
      [
        prepared.refundId,
        feeReversedFils,
        acquirerResult.acquirerReference,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      prepared.transactionId,
      newRefundedTotal,
      newStatus,
    ]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, prepared.merchantId, prepared.transactionId, prepared.requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, prepared.merchantId, prepared.transactionId, feeReversedFils],
      );
    }

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, currentCapturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: prepared.transactionId,
      eventType,
      amountFils: toFils(-prepared.requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: prepared.transactionId,
      payload: {
        merchantId: prepared.merchantId,
        refundId: refund.id,
        amountFils: prepared.requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: prepared.transactionId,
      merchantId: prepared.merchantId,
      amountFils: prepared.requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, prepared.claimId, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}
