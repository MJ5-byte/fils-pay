/**
 * recordPayoutDisbursementEffect writes the operational record of a payout-rail
 * transfer instruction. Requires DATABASE_URL to point at a real, migrated
 * Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { recordPayoutDisbursementEffect } from "./payoutDisbursement.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "payoutDisbursement.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createPaidBatch(netPayoutFils: number): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Disbursement Test Merchant ${randomUUID()}`, 250],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches
        (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, current_date, 'paid', $2, 0, $2, now(), now())
     RETURNING id`,
    [merchant.rows[0]!.id, netPayoutFils],
  );
  return batch.rows[0]!.id;
}

// FH: only checks the insert, not who calls it or how often
test("recordPayoutDisbursementEffect inserts one row with the given batch id and amount", async () => {
  const batchId = await createPaidBatch(471_300);

  await recordPayoutDisbursementEffect(pool, batchId);

  const result = await pool.query<{ amount_fils: string; disbursement_reference: string }>(
    `SELECT amount_fils, disbursement_reference FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`,
    [batchId],
  );

  assert.equal(result.rows.length, 1);
  assert.equal(Number(result.rows[0]!.amount_fils), 471_300);
  assert.ok(
    result.rows[0]!.disbursement_reference.startsWith("disb_"),
    "expected a generated disbursement reference distinct from the batch id",
  );
  assert.notEqual(result.rows[0]!.disbursement_reference, batchId);
});
