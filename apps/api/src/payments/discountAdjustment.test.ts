/**
 * Tests for the negotiated-discount capture adjustment, against a real,
 * migrated Postgres (no DB mocking) — same as transactions.test.ts and
 * settlement.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyCaptureDiscountAdjustment } from "./discountAdjustment.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "discountAdjustment.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function seedCapturedTransaction(opts: {
  mdrBps: number;
  discountBps: number;
  capturedFils: number;
  feeFils: number;
}): Promise<{ merchantId: string; transactionId: string }> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Discount Test ${randomUUID()}`, opts.mdrBps, opts.discountBps],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', $2, $2, $3) RETURNING id`,
    [merchantId, opts.capturedFils, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;

  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'captured', $2, 'system', $3)`,
    [transactionId, opts.capturedFils, JSON.stringify({ feeFils: opts.feeFils })],
  );

  return { merchantId, transactionId };
}

async function adjustmentLegs(transactionId: string): Promise<Array<{ account_id: string; direction: string; amount_fils: string }>> {
  const result = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'
      ORDER BY account_id`,
    [transactionId],
  );
  return result.rows;
}

/** Fee first, then discount: 602 fils @ 275 bps = 17 fils fee; 12.5% of 17 rounds to 2. */
test("posts a rebate leg pair sized by the discount applied to the fee already charged", async () => {
  // 602 fils captured at 275bps MDR charges 17 fils; a 1250bps negotiated
  // discount rebates bankersRoundDiv(17*1250, 10000) = 2 fils, leaving the
  // merchant charged 15 fils net.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 1250,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const legs = await adjustmentLegs(transactionId);
  assert.deepEqual(legs, [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "2" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "2" },
  ]);
});

test("a merchant with no negotiated discount produces no rows at all", async () => {
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 0,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), []);
});

test("a fee that rounds the discount down to zero posts nothing", async () => {
  // 7 fils of fee at 100bps rebates bankersRoundDiv(700, 10000) = 0 fils —
  // ledger_entries has a CHECK (amount_fils > 0), so no leg is written.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 100,
    capturedFils: 250,
    feeFils: 7,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), []);
});

// this is the FP-219 regression test — FH
test("re-running against the same capture event does not rebate the fee twice", async () => {
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 275,
    discountBps: 1250,
    capturedFils: 602,
    feeFils: 17,
  });

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.equal((await adjustmentLegs(transactionId)).length, 2);
});

// BHA-145 regression: a capture whose rebate rounds to zero posts no ledger
// row, so a guard that counts raw capture events stays permanently short and a
// later capture's discount replays a second time. The guard must count only
// the capture events whose rebate actually rounds above zero.
test("a zero-rebate capture does not make a later capture's discount credit twice on replay", async () => {
  // discount 100bps: a 7-fil fee rebates bankersRoundDiv(700, 10000) = 0 (no
  // leg written), a 200-fil fee rebates bankersRoundDiv(20000, 10000) = 2.
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, 275, 100) RETURNING id`,
    [`Discount Replay ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 1000, 1000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;

  // Earlier partial capture: rebate rounds to zero, writes no adjustment leg.
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'partially_captured', 250, 'system', $2)`,
    [transactionId, JSON.stringify({ feeFils: 7 })],
  );
  // Later capture: rebate rounds to 2 fils. Higher id, so it is the latest.
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'captured', 750, 'system', $2)`,
    [transactionId, JSON.stringify({ feeFils: 200 })],
  );

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  // Replay of the later capture (cached 200, no new event) must be a no-op.
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "2" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "2" },
  ]);
});
