import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";

/** Writes at most one payout disbursement record per settlement batch. */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    // The record belongs to the payout, not to a webhook delivery.
    // Replays and extra endpoints each reach this path at attempt 0.
    // The batch row lock serializes concurrent passes for the same payout.
    // The amount comes from the locked batch row rather than the webhook payload.
    const batch = await client.query<{ net_payout_fils: string }>(
      `SELECT net_payout_fils FROM settlement_batches WHERE id = $1 FOR UPDATE`,
      [settlementBatchId],
    );
    const row = batch.rows[0];
    if (!row) return;
    const amountFils = Number(row.net_payout_fils);
    if (amountFils <= 0) {
      // Void batches (zero or negative net) carry no payout instruction.
      return;
    }

    const existing = await client.query(
      `SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1 LIMIT 1`,
      [settlementBatchId],
    );
    if (existing.rows.length > 0) return;

    await client.query(
      `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     VALUES ($1, $2, 'disb_' || gen_random_uuid())`,
      [settlementBatchId, amountFils],
    );
  });
}
