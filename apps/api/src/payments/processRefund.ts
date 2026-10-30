import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
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
  actor: { type: "merchant_session" | "merchant_api_key" | "system"; id: string };
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

/** Refund business logic: validate, call the acquirer, then journal the reversal. */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  // 1 validate
  const prepared = await withTransaction(pool, async (client) => {
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

    // Lock the transaction row BEFORE reading anything the decision depends
    // on, and scope it to the caller's merchant. Two concurrent refunds (or a
    // refund racing a capture) serialise here; the loser sees the winner's
    // pending reservation below.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "settled" as const, result: { statusCode: 404, body } };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // Refunds already reserved but not yet settled count against the ceiling.
    const pendingResult = await client.query<{ pending_fils: string }>(
      `SELECT COALESCE(SUM(amount_fils), 0)::text AS pending_fils
         FROM refunds
        WHERE transaction_id = $1 AND status = 'pending'`,
      [txn.id],
    );
    const pendingFils = toFils(Number(pendingResult.rows[0]?.pending_fils ?? "0"));

    // What can still go back is what was CAPTURED minus what has already been
    // (or is being) refunded -- never the authorised amount.
    const refundableFils = subtractFils(subtractFils(capturedFils, refundedFils), pendingFils);

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

    // The fee this transaction actually keeps, read from the ledger rather
    // than recomputed from today's mdr_bps: MDR credited at capture, less any
    // negotiated-discount rebate already given back to the merchant.
    const feeResult = await client.query<{ fee_fils: string; reversed_fils: string }>(
      `SELECT (SELECT COALESCE(SUM(amount_fils), 0)
                 FROM ledger_entries
                WHERE transaction_id = $1
                  AND account_id = 'platform_fee_revenue'
                  AND direction = 'credit')
              -
              (SELECT COALESCE(SUM(amount_fils), 0)
                 FROM ledger_entries
                WHERE transaction_id = $1
                  AND account_id = 'platform_fee_revenue'
                  AND direction = 'debit'
                  AND description = 'capture: negotiated discount adjustment') AS fee_fils,
              (SELECT COALESCE(SUM(fee_reversed_fils), 0)
                 FROM refunds
                WHERE transaction_id = $1 AND status = 'succeeded') AS reversed_fils`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    // Reserve the amount. Settled to succeeded/failed in step 3.
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, status, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)
       RETURNING id`,
      [
        txn.id,
        txn.merchant_id,
        validation.amountFils,
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const reservationRow = reservation.rows[0];
    if (!reservationRow) {
      throw new Error("processRefund: reservation insert returned no row");
    }

    return {
      kind: "proceed" as const,
      refundId: reservationRow.id,
      claimId: claim.row.id,
      attemptCount: claim.row.attemptCount,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      acquirerReference: txn.acquirer_reference,
      amountAuthorized,
      capturedFils,
      feeChargedFils: toFils(Math.max(0, Number(feeRow.fee_fils))),
      feeAlreadyReversedFils: toFils(Number(feeRow.reversed_fils)),
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
  return withTransaction(pool, async (client) => {
    if (acquirerResult.outcome === "declined" || acquirerResult.outcome === "error") {
      // Release the reservation so the amount is refundable again. The row is
      // removed rather than kept as 'failed': a refund that never happened
      // leaves no refund record (the idempotency key keeps the attempt).
      await client.query(`DELETE FROM refunds WHERE id = $1 AND status = 'pending'`, [
        prepared.refundId,
      ]);
      if (acquirerResult.outcome === "declined") {
        const body = { error: "refund_declined" };
        await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
        return { statusCode: 402, body };
      }
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    // Re-lock the row and apply the delta in SQL, so the new running total is
    // derived from what is committed now, not from a value read before the
    // acquirer call.
    const lockedTxn = await client.query<{ refunded_fils: string | number }>(
      `UPDATE transactions
          SET refunded_fils = refunded_fils + $2
        WHERE id = $1
        RETURNING refunded_fils`,
      [prepared.transactionId, prepared.requestedAmount],
    );
    const newRefundedTotal = toFils(Number(lockedTxn.rows[0]?.refunded_fils ?? 0));
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: prepared.capturedFils,
      refundedTotalFils: newRefundedTotal,
    });

    // Fee reversal: the refund's proportional share of the fee the transaction
    // keeps, except that the refund which returns the last captured fils
    // reverses whatever is left, so independently-rounded partial shares can
    // never leave fils behind (or hand back more than was charged).
    const remainingReversible = subtractFils(prepared.feeChargedFils, prepared.feeAlreadyReversedFils);
    const isFinal = compareFils(newRefundedTotal, prepared.capturedFils) >= 0;
    const proportional = calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, prepared.requestedAmount);
    const feeReversedFils =
      compareFils(remainingReversible, ZERO_FILS) <= 0
        ? ZERO_FILS
        : isFinal
          ? remainingReversible
          : compareFils(proportional, remainingReversible) > 0
            ? remainingReversible
            : proportional;

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `UPDATE refunds
          SET status = 'succeeded', fee_reversed_fils = $2, acquirer_reference = $3
        WHERE id = $1 AND status = 'pending'
        RETURNING id, occurred_at`,
      [prepared.refundId, feeReversedFils, acquirerResult.acquirerReference],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: pending refund reservation vanished before it could be settled");
    }

    await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [prepared.transactionId, newStatus]);
    if (newStatus === "refunded") {
      // Nothing left to draw on: release any authorisation headroom hold.
      await client.query(`UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, [
        prepared.transactionId,
      ]);
    }

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
    const eventType = compareFils(newRefundedTotal, prepared.capturedFils) >= 0 ? "refunded" : "refund_partial";

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
