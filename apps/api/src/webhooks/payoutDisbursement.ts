import type { Pool } from "pg";

/**
 * Operational record of a payout-rail instruction for a settlement batch.
 * Idempotent per batch: the unique index on settlement_batch_id (migration
 * 0076) plus ON CONFLICT DO NOTHING means a second run for the same batch —
 * a concurrent dispatch pass, or a replay that re-runs the effect — is a
 * no-op instead of a duplicate disbursement record.
 */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  await pool.query(
    `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     VALUES ($1, $2, 'disb_' || gen_random_uuid())
     ON CONFLICT (settlement_batch_id) DO NOTHING`,
    [settlementBatchId, amountFils],
  );
}
