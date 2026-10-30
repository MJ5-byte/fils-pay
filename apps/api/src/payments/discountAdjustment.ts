import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyRateFils, bankersRoundDiv, parseBhdToFils, toFils, type Fils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError } from "../lib/errors.js";

const CAPTURE_FEE_DESCRIPTION = "capture: MDR fee";
const DISCOUNT_DESCRIPTION = "capture: negotiated discount adjustment";

/**
 * Parses a promotional discount amount (BD string from the merchant
 * pricing dashboard) into fils for the ledger adjustment.
 */
export function parsePromotionalDiscountFils(raw: string): Fils {
  let fils: Fils;
  try {
    fils = parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  if (fils < 0) {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  return fils;
}

/**
 * Applies a merchant's negotiated processing discount against the MDR fee
 * capture.ts already charged, per the merchant's pricing agreement: the
 * discount applies to our processing fee, after it's calculated — see the
 * partner-pricing addendum. capture.ts's own response doesn't carry the
 * fee it just charged, so this reads it back from the platform_fee_revenue
 * leg capture.ts already posted, then reverses the merchant's share via a
 * same-day ledger adjustment. capture.ts posts it through
 * postCaptureDiscountAdjustment in the capture's own transaction; this
 * wrapper is the idempotent catch-up the capture paths still run afterwards,
 * which finds nothing owed unless a capture from before BHA-235 lost its
 * rebate.
 *
 * A merchant with negotiated_discount_bps = 0 (the default for anyone
 * without a negotiated rate) is a no-op: this
 * function reads the merchant row, sees a zero discount rate, and inserts
 * nothing.
 */
export async function applyCaptureDiscountAdjustment(
  pool: Pool,
  input: { merchantId: string; transactionId: string },
): Promise<void> {
  return withTransaction(pool, (client) => postCaptureDiscountAdjustment(client, input));
}

/**
 * The same adjustment, inside a transaction the caller already holds.
 * capture.ts calls it right after posting the fee leg, so the rebate commits
 * or rolls back with the capture and carries the capture's own now(): a
 * rebate posted later could land on another business day, outside the batch
 * that settles its capture (CloseBatch only reads rebates from its own day).
 */
export async function postCaptureDiscountAdjustment(
  client: PoolClient,
  input: { merchantId: string; transactionId: string },
): Promise<void> {
  const merchantRow = await client.query<{ negotiated_discount_bps: number }>(
    `SELECT negotiated_discount_bps FROM merchants WHERE id = $1`,
    [input.merchantId],
  );
  const discountBps = merchantRow.rows[0]?.negotiated_discount_bps ?? 0;
  if (discountBps === 0) return;

  // The row lock serializes this against a concurrent capture, refund or
  // replay of the same transaction, so the ledger read below is the whole
  // story for it.
  await client.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [input.transactionId]);

  // The captures still owed a rebate are the MDR fee legs capture.ts posted
  // after the last adjustment: ledger ids come from one sequence and every
  // writer holds the row lock above, so "after" is insertion order. A
  // replayed (idempotent) capture posts no new fee leg, so it finds nothing
  // to rebate. A capture whose rebate rounds or shrinks to zero posts no row
  // (ledger_entries has CHECK amount_fils > 0) and is simply covered by the
  // next adjustment's window, where a count of rows against capture events
  // stayed short for good and let a later capture's rebate replay twice.
  const feeLegs = await client.query<{ direction: string; amount_fils: string; description: string | null }>(
    `SELECT direction, amount_fils, description FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'
      ORDER BY id`,
    [input.transactionId],
  );

  // A refund can take the row lock before this runs (on a capture from
  // before BHA-235, whose discount posted in its own transaction after the
  // capture committed, or was replayed after it failed) and reverse its
  // share of the fee held, which still includes
  // the rebate owed. Each reversal after a capture's fee leg shrinks what is
  // owed on it by the same share of the fee it reversed, which is what a
  // discount posted first would have left after that refund; a reversal
  // before the leg never touched that fee. The owed rebate is kept as an
  // exact fraction and rounded once.
  let feeHeldFils = 0;
  let owedNumerator = 0n;
  let owedDenominator = 1n;
  for (const leg of feeLegs.rows) {
    const amount = toFils(Number(leg.amount_fils));
    if (leg.direction === "credit") {
      feeHeldFils += amount;
      if (leg.description === CAPTURE_FEE_DESCRIPTION) {
        owedNumerator += BigInt(applyRateFils(amount, discountBps)) * owedDenominator;
      }
      continue;
    }
    const heldAfter = feeHeldFils - amount;
    if (leg.description === DISCOUNT_DESCRIPTION || heldAfter <= 0) {
      owedNumerator = 0n;
      owedDenominator = 1n;
    } else {
      owedNumerator *= BigInt(heldAfter);
      owedDenominator *= BigInt(feeHeldFils);
    }
    feeHeldFils = heldAfter;
  }

  if (feeHeldFils <= 0) return;
  const discountFils = bankersRoundDiv(owedNumerator, owedDenominator);
  if (discountFils <= 0) return;

  const entryGroupId = randomUUID();
  await client.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), $5),
       ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), $5)`,
    [entryGroupId, input.merchantId, input.transactionId, discountFils, DISCOUNT_DESCRIPTION],
  );
}
