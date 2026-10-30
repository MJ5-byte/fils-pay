/**
 * BHA-122, BHA-117, BHA-119: the database itself must refuse a refund total
 * above the captured amount, a merchant MDR rate outside 0..10000 bps and a
 * negative settlement payout. The app layer is the first guard; these
 * constraints are the last one, so the tests insert straight into a real,
 * migrated Postgres, the same setup as feeScheduleMdrBound.new.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "moneyChecks.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Money Checks Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

function violates(constraint: string) {
  return (err: unknown): true => {
    assert.ok(err && typeof err === "object" && "code" in err, "expected a pg error");
    assert.equal((err as { code?: string }).code, "23514", "expected a check-constraint violation");
    assert.equal((err as { constraint?: string }).constraint, constraint);
    return true;
  };
}

test("transactions rejects refunded_fils above captured_fils", async () => {
  const merchantId = await createMerchant();
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
         VALUES ($1, 'captured', 10000, 4000, 4001, $2)`,
        [merchantId, `acq_${randomUUID()}`],
      ),
    violates("transactions_refunded_within_captured"),
  );
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     VALUES ($1, 'refunded', 10000, 4000, 4000, $2)`,
    [merchantId, `acq_${randomUUID()}`],
  );
});

test("merchants rejects an mdr_bps outside 0..10000", async () => {
  for (const bps of [-1, 10001]) {
    await assert.rejects(
      () => pool.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2)`, [`Bad MDR ${randomUUID()}`, bps]),
      violates("merchants_mdr_bps_range"),
    );
  }
  const merchantId = await createMerchant();
  await assert.rejects(
    () => pool.query(`UPDATE merchants SET mdr_bps = 10001 WHERE id = $1`, [merchantId]),
    violates("merchants_mdr_bps_range"),
  );
  for (const bps of [0, 10000]) {
    await pool.query(`UPDATE merchants SET mdr_bps = $2 WHERE id = $1`, [merchantId, bps]);
  }
});

test("settlement_batches rejects a negative net_payout_fils", async () => {
  const merchantId = await createMerchant();
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO settlement_batches (merchant_id, batch_date, gross_fils, fee_fils, net_payout_fils)
         VALUES ($1, '2026-01-01', 1000, 2000, -1000)`,
        [merchantId],
      ),
    violates("settlement_batches_net_payout_non_negative"),
  );
  await pool.query(
    `INSERT INTO settlement_batches (merchant_id, batch_date, gross_fils, fee_fils, net_payout_fils)
     VALUES ($1, '2026-01-02', 0, 0, 0)`,
    [merchantId],
  );
});
