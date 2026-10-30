/**
 * Tests for the negotiated-discount capture adjustment, against a real,
 * migrated Postgres (no DB mocking) — same as transactions.test.ts and
 * settlement.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { applyCaptureDiscountAdjustment, parsePromotionalDiscountFils } from "./discountAdjustment.js";
import { processRefund } from "./processRefund.js";

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
  await seedFeeLegs(merchantId, transactionId, opts.feeFils);

  return { merchantId, transactionId };
}

/** The MDR fee leg pair capture.ts posts alongside each capture event. */
async function seedFeeLegs(merchantId: string, transactionId: string, feeFils: number): Promise<void> {
  await pool.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'capture: MDR fee'),
       ($1, $2, $3, 'platform_fee_revenue', 'credit', $4, now(), 'capture: MDR fee')`,
    [randomUUID(), merchantId, transactionId, feeFils],
  );
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
  await seedFeeLegs(merchantId, transactionId, 7);
  // Later capture: rebate rounds to 2 fils. Higher id, so it is the latest.
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'captured', 750, 'system', $2)`,
    [transactionId, JSON.stringify({ feeFils: 200 })],
  );
  await seedFeeLegs(merchantId, transactionId, 200);

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  // Replay of the later capture (cached 200, no new event) must be a no-op.
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "2" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "2" },
  ]);
});

const approvingAcquirer: AcquirerSimulator = {
  authorize() {
    throw new Error("approvingAcquirer: authorize is not used by these tests");
  },
  capture() {
    throw new Error("approvingAcquirer: capture is not used by these tests");
  },
  refund(req) {
    return Promise.resolve({ outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 });
  },
};

async function refund(merchantId: string, transactionId: string, amountFils: number): Promise<void> {
  const result = await processRefund(pool, approvingAcquirer, {
    transactionId,
    merchantId,
    amountFils: toFils(amountFils),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
}

async function netPlatformFee(transactionId: string): Promise<number> {
  const result = await pool.query<{ fils: string }>(
    `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fils
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return Number(result.rows[0]?.fils);
}

// BHA-169: the discount posts in its own transaction after capture commits,
// so a refund can take the row lock first (or the discount step fails and is
// replayed after a refund). The refund then reverses the gross fee, and a
// discount posted on top of that hands the merchant money the platform never
// kept.
test("a full refund that lands before the discount leaves nothing to rebate (BHA-169)", async () => {
  // 10 000 fils at 250 bps charges 250; a 1000 bps discount would rebate 25.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 250,
    discountBps: 1000,
    capturedFils: 10_000,
    feeFils: 250,
  });

  await refund(merchantId, transactionId, 10_000);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), []);
  assert.equal(await netPlatformFee(transactionId), 0);
});

test("a partial refund that lands before the discount rebates only the fee still held (BHA-169)", async () => {
  // Discount first: 25 rebated, 225 kept, and refunding 9 500 then reverses
  // bankersRoundDiv(225 * 9500, 10000) = 214, so the platform keeps 11 on the
  // 500 still captured. Refund first reverses bankersRoundDiv(250 * 9500,
  // 10000) = 238 of the gross fee, so the discount applies to the 12 still
  // held: 1 rebated, 11 kept, the same as the other order.
  const { merchantId, transactionId } = await seedCapturedTransaction({
    mdrBps: 250,
    discountBps: 1000,
    capturedFils: 10_000,
    feeFils: 250,
  });

  await refund(merchantId, transactionId, 9_500);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "1" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "1" },
  ]);
  assert.equal(await netPlatformFee(transactionId), 11);

  await refund(merchantId, transactionId, 500);
  assert.equal(await netPlatformFee(transactionId), 0);
});

test("a capture whose rebate is skipped after a refund does not make a later capture's rebate replay (BHA-169)", async () => {
  // 4 000 of 10 000 captured at 250 bps (fee 100) and refunded in full before
  // its discount posts, so that rebate is skipped. The next 6 000 (fee 150)
  // rebates 15 once; replaying that capture must not post it again.
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, 250, 1000) RETURNING id`,
    [`Discount Skip Replay ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'partially_captured', 10000, 4000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'partially_captured', 4000, 'system', $2)`,
    [transactionId, JSON.stringify({ feeFils: 100 })],
  );
  await seedFeeLegs(merchantId, transactionId, 100);

  await refund(merchantId, transactionId, 4_000);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  assert.deepEqual(await adjustmentLegs(transactionId), []);

  await pool.query(`UPDATE transactions SET status = 'captured', captured_fils = 10000 WHERE id = $1`, [transactionId]);
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata)
     VALUES ($1, 'captured', 6000, 'system', $2)`,
    [transactionId, JSON.stringify({ feeFils: 150 })],
  );
  await seedFeeLegs(merchantId, transactionId, 150);

  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  assert.deepEqual(await adjustmentLegs(transactionId), [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "15" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "15" },
  ]);
  assert.equal(await netPlatformFee(transactionId), 135);
});

test("a refund that lands between a second capture and its discount rebates only that capture's unrefunded share (BHA-169)", async () => {
  // Capture 4 000 (fee 100, rebate 10), then 6 000 (fee 150, rebate 15 owed).
  // Discount first: 225 kept, then refunding 6 000 reverses
  // bankersRoundDiv(225 * 6000, 10000) = 135, so 90 is kept. Refund first
  // reverses bankersRoundDiv(240 * 6000, 10000) = 144 of the 240 charged net
  // of the first rebate, so 96 of 240 is still held and the second rebate is
  // 15 * 96 / 240 = 6: 90 kept either way.
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, 250, 1000) RETURNING id`,
    [`Discount Second Capture ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'partially_captured', 10000, 4000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;
  await seedFeeLegs(merchantId, transactionId, 100);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  await pool.query(`UPDATE transactions SET status = 'captured', captured_fils = 10000 WHERE id = $1`, [transactionId]);
  await seedFeeLegs(merchantId, transactionId, 150);
  await refund(merchantId, transactionId, 6_000);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const rebates = await pool.query<{ amount_fils: string }>(
    `SELECT amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment' AND direction = 'debit'
      ORDER BY id`,
    [transactionId],
  );
  assert.deepEqual(
    rebates.rows.map((row) => row.amount_fils),
    ["10", "6"],
  );
  assert.equal(await netPlatformFee(transactionId), 90);
});

test("a refund before a later capture does not shrink that capture's rebate (BHA-169)", async () => {
  // No race: each discount posts right after its capture. Capture 4 000 (fee
  // 100, rebate 10), refund 2 000 (reverses 45 of the 90 kept), then capture
  // 6 000 (fee 150). The refund never touched the 150, so its rebate is the
  // full 15, not 15 scaled by the transaction's overall held share.
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, 250, 1000) RETURNING id`,
    [`Discount Refund Before Capture ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'partially_captured', 10000, 4000, $2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;
  await seedFeeLegs(merchantId, transactionId, 100);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });
  await refund(merchantId, transactionId, 2_000);

  await pool.query(`UPDATE transactions SET status = 'captured', captured_fils = 10000 WHERE id = $1`, [transactionId]);
  await seedFeeLegs(merchantId, transactionId, 150);
  await applyCaptureDiscountAdjustment(pool, { merchantId, transactionId });

  const rebates = await pool.query<{ amount_fils: string }>(
    `SELECT amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment' AND direction = 'debit'
      ORDER BY id`,
    [transactionId],
  );
  assert.deepEqual(
    rebates.rows.map((row) => row.amount_fils),
    ["10", "15"],
  );
});

test("parsePromotionalDiscountFils reads BD at 1000 fils per BD and rejects a fourth decimal (BHA-59)", () => {
  assert.equal(parsePromotionalDiscountFils("4.75"), 4750);
  assert.equal(parsePromotionalDiscountFils("4.755"), 4755);
  assert.throws(() => parsePromotionalDiscountFils("4.7555"), { code: "invalid_discount" });
  assert.throws(() => parsePromotionalDiscountFils("-1"), { code: "invalid_discount" });
});
