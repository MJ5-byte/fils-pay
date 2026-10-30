import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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

/** Validates, refunds and journals inside one row-locked transaction. */
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

  return withTransaction(pool, async (client) => {
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
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    // Hold the lock across the acquirer call so a second refund waits and sees the first refund's total.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1
        FOR UPDATE`,
      [input.transactionId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    const refundableFils = subtractFils(capturedFils, refundedFils);

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
      return { statusCode, body: validation };
    }

    // The fee this transaction was actually charged at capture, read from
    // the ledger rather than recomputed from the merchant's current
    // mdr_bps, so a rate change after capture can never retroactively alter
    // what a refund reverses.
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(amount_fils), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND direction = 'credit'`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    const feeChargedFils = toFils(Number(feeRow.fee_fils));
    const requestedAmount = validation.amountFils;

    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });

    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const feeReversedFils = calculateRefundFee(
      capturedFils,
      feeChargedFils,
      requestedAmount,
    );

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       ON CONFLICT (acquirer_reference) DO NOTHING
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      // A refund already exists for this acquirer reference: a duplicate or
      // re-posted refund. Return the refund that was recorded first and move
      // no money again, rather than inserting a second row and reversing the
      // fee twice (BHA-123).
      return replayExistingRefund(client, claim.row.id, acquirerResult.acquirerReference);
    }

    const updateResult = await client.query<{ refunded_fils: string | number }>(
      `UPDATE transactions SET refunded_fils = refunded_fils + $2 WHERE id = $1 RETURNING refunded_fils`,
      [txn.id, requestedAmount],
    );
    const row = updateResult.rows[0];
    if (!row) {
      throw new Error("processRefund: refunded_fils update returned no row");
    }
    const newRefundedTotal = toFils(Number(row.refunded_fils));
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [txn.id, newStatus]);

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
      [entryGroupId, txn.merchant_id, txn.id, requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, txn.merchant_id, txn.id, feeReversedFils],
      );
    }

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
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
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        refundId: refund.id,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, claim.row.id, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}

interface ExistingRefundRow {
  id: string;
  amount_fils: string | number;
  fee_reversed_fils: string | number;
  occurred_at: Date;
  transaction_id: string;
  merchant_id: string;
  transaction_status: string;
  refunded_fils: string | number;
}

/**
 * The refund insert hit the unique acquirer_reference: a refund with this
 * reference was already recorded. Return that first refund unchanged, so a
 * duplicate attempt reads as a replay and never moves money a second time.
 */
async function replayExistingRefund(
  client: PoolClient,
  claimId: string,
  acquirerReference: string,
): Promise<ProcessRefundResult> {
  const existing = await client.query<ExistingRefundRow>(
    `SELECT r.id, r.amount_fils, r.fee_reversed_fils, r.occurred_at,
            t.id AS transaction_id, t.merchant_id,
            t.status AS transaction_status, t.refunded_fils
       FROM refunds r
       JOIN transactions t ON t.id = r.transaction_id
      WHERE r.acquirer_reference = $1`,
    [acquirerReference],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error("processRefund: refund conflict but no existing refund found");
  }

  const body = {
    id: row.id,
    transactionId: row.transaction_id,
    merchantId: row.merchant_id,
    amountFils: toFils(Number(row.amount_fils)),
    feeReversedFils: toFils(Number(row.fee_reversed_fils)),
    status: "succeeded",
    transactionStatus: row.transaction_status,
    refundedTotalFils: toFils(Number(row.refunded_fils)),
    acquirerReference,
    occurredAt: row.occurred_at.toISOString(),
  };
  await completeIdempotencyKey(client, claimId, { statusCode: 200, body, resourceId: row.id });
  return { statusCode: 200, body };
}
