import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { compareFils, toFils, type Fils } from "@filspay/money";
import { UnprocessableEntityError } from "../lib/errors.js";
import { CREDIT_APPROVAL_THRESHOLD_FILS } from "./creditThreshold.js";

/** Posts a balanced ledger_entries group for a manual adjustment delta. */
export async function postLedgerAdjustment(
  client: PoolClient,
  merchantId: string,
  amountFils: Fils,
  description = "manual balance adjustment",
): Promise<string | null> {
  // Positive adjustments are paid at the next close (ADR-0008), so above the credit threshold they need the credit flow's second approver.
  if (compareFils(amountFils, CREDIT_APPROVAL_THRESHOLD_FILS) > 0) {
    throw new UnprocessableEntityError(
      "adjustment_needs_second_approver",
      "a positive adjustment above 50.000 BD needs a second approver: post it as a manual credit instead",
    );
  }
  if (amountFils === 0) return null;

  const entryGroupId = randomUUID();
  const magnitude = toFils(Math.abs(amountFils));
  if (amountFils > 0) {
    await client.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, 'manual_balance_adjustment_contra', 'debit',  $3, now(), $4),
         ($1, $2, 'merchant_payable',                 'credit', $3, now(), $4)`,
      [entryGroupId, merchantId, magnitude, description],
    );
  } else {
    await client.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, 'merchant_payable',                 'debit',  $3, now(), $4),
         ($1, $2, 'manual_balance_adjustment_contra', 'credit', $3, now(), $4)`,
      [entryGroupId, merchantId, magnitude, description],
    );
  }

  return entryGroupId;
}
