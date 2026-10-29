import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
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

  // The whole refund is one transaction: claim -> row-lock -> validate ->
  // acquirer -> journal. `SELECT ... FOR UPDATE` on the transactions row is
  // held across the acquirer call — the same pattern capture.ts uses — so
  // two concurrent refunds of the same transaction can never both pass
  // validation: the second blocks on the row lock and then sees the first
  // one's committed refunded_fils, which makes it fail validation before
  // any money moves. (B9)
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

    // The refundable ceiling is what was actually captured and still
    // unrefunded — never the authorized amount, which may exceed what the
    // acquirer ever took (a partial capture). Refunding beyond the captured
    // total would move money that was never taken. (B8)
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
    // Net fee actually charged at capture: the capture-time MDR credit leg
    // minus any separately-booked negotiated-discount debit, and never
    // including a prior refund's fee-reversal debit (description 'refund:%'),
    // so a second partial refund reverses against the correct remaining fee.
    // (F2)
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(
                 CASE WHEN direction = 'credit' THEN amount_fils
                      ELSE -amount_fils END
               ), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND (description IS NULL OR description NOT LIKE 'refund:%')`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }
    const feeChargedFils = toFils(Number(feeRow.fee_fils));

    // 2 acquirer — called while the transactions row lock is still held, so
    // a concurrent loser can never reach the acquirer and move money twice.
    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: validation.amountFils,
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

    // 3 journal
    const newRefundedTotal = addFils(refundedFils, validation.amountFils);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    const feeReversedFils = calculateRefundFee(capturedFils, feeChargedFils, validation.amountFils);

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        validation.amountFils,
        feeReversedFils,
        acquirerResult.acquirerReference,
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      txn.id,
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
      [entryGroupId, txn.merchant_id, txn.id, validation.amountFils],
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
      amountFils: toFils(-validation.amountFils, { allowNegative: true }),
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
        amountFils: validation.amountFils,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: validation.amountFils,
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
