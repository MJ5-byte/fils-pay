/**
 * Tests for runConsumerPass: the transactional
 * atomicity claim (a mid-batch throw rolls back the WHOLE pass — neither the
 * watermark nor any rollup write from that batch persists), and an
 * end-to-end pass over real events enqueued via @filspay/events'
 * enqueueEvent with the exact payload shapes capture.ts/void.ts and
 * CloseBatch produce. Requires DATABASE_URL to point at a real, migrated
 * Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass, CONSUMER_NAME } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("runConsumerPass.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`runConsumerPass Test Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function getCursor(): Promise<bigint> {
  const result = await pool.query<{ last_processed_id: string }>(
    `SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  return result.rows[0] ? BigInt(result.rows[0].last_processed_id) : 0n;
}

test("runConsumerPass: end-to-end over real events with the producers' exact payload shapes populates merchant_daily_volume and advances the watermark", async () => {
  const merchantId = await createMerchant("e2e-volume");
  const txnId = randomUUID();

  const capturedEvent = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: txnId,
    payload: { merchantId, amountCapturedFils: 6_000, feeFils: 90, newStatus: "captured", capturedTotalFils: 6_000 },
  });
  const voidedTxnId = randomUUID();
  const voidedEvent = await enqueueEvent(pool, {
    eventType: "transaction.voided",
    aggregateType: "transaction",
    aggregateId: voidedTxnId,
    payload: { merchantId },
  });

  const before = await getCursor();
  const { processedCount } = await runConsumerPass(pool, config);
  assert.ok(processedCount >= 2, "at least this test's two events were processed (shared DB across the suite)");

  const after = await getCursor();
  assert.ok(after > before, "watermark advanced");
  assert.ok(after >= voidedEvent.id, "watermark reached at least this pass's highest id");
  assert.ok(voidedEvent.id > capturedEvent.id);

  const volumeDate = capturedEvent.createdAt.toISOString().slice(0, 10); // UTC same-day at test time in practice
  const result = await pool.query(
    `SELECT captured_count, captured_gross_fils, voided_count FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].captured_count, 1);
  assert.equal(Number(result.rows[0].captured_gross_fils), 6_000);
  assert.equal(result.rows[0].voided_count, 1);
  void volumeDate;

  const cursorRow = await pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  assert.ok(cursorRow.rows[0]!.updated_at.getTime() <= Date.now());
});

test("runConsumerPass: end-to-end settlement.batch_closed populates merchant_payout_trends", async () => {
  const merchantId = await createMerchant("e2e-payout");
  const batchResult = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, '2026-02-01', 'paid', 8_000, 200, 7_800, now(), now())
     RETURNING id`,
    [merchantId],
  );
  const batchId = batchResult.rows[0]!.id;

  await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-02-01", grossFils: 8_000, feeFils: 200, netPayoutFils: 7_800 },
  });

  await runConsumerPass(pool, config);

  const result = await pool.query(
    `SELECT status, gross_fils, fee_fils, net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "paid");
  assert.equal(Number(result.rows[0].gross_fils), 8_000);
  assert.equal(Number(result.rows[0].fee_fils), 200);
  assert.equal(Number(result.rows[0].net_payout_fils), 7_800);
});

test("runConsumerPass: end-to-end refund.succeeded lands refund_count/refund_gross_fils in merchant_daily_volume and refreshes refund_merchant_summary", async () => {
  const merchantId = await createMerchant("e2e-refund");

  // Seed the refund the way processRefund journals it (refunds row + its
  // transaction), so the refreshed matview has something to materialize.
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'refunded', 5_000, 5_000, $2, now())
     RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id)
     VALUES ($1, $2, 5_000, 75, 'succeeded', $3, 'test', 'merchant_api_key', $2)`,
    [txnResult.rows[0]!.id, merchantId, `acq_${randomUUID()}`],
  );

  await enqueueEvent(pool, {
    eventType: "refund.succeeded",
    aggregateType: "transaction",
    aggregateId: txnResult.rows[0]!.id,
    payload: {
      merchantId,
      refundId: randomUUID(),
      amountFils: 5_000,
      feeReversedFils: 75,
      refundedTotalFils: 5_000,
      newStatus: "refunded",
    },
  });

  const { processedCount } = await runConsumerPass(pool, config);
  assert.ok(processedCount >= 1, "at least this test's refund event was processed");

  const volume = await pool.query(
    `SELECT refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(volume.rows.length, 1);
  assert.equal(Number(volume.rows[0].refund_count), 1);
  assert.equal(Number(volume.rows[0].refund_gross_fils), 5_000);

  // The after-pass matview refresh must have picked up the seeded refund.
  const summary = await pool.query(
    `SELECT refund_count, total_refunded_fils FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(summary.rows.length, 1);
  assert.equal(Number(summary.rows[0].refund_count), 1);
  assert.equal(Number(summary.rows[0].total_refunded_fils), 5_000);
});

test("runConsumerPass: end-to-end settlement.paid flips the trend row from closed to the batch's live paid state", async () => {
  const merchantId = await createMerchant("e2e-paid");
  const batchResult = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, '2026-09-01', 'closed', 6_000, 150, 5_850, now(), NULL)
     RETURNING id`,
    [merchantId],
  );
  const batchId = batchResult.rows[0]!.id;

  await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-01", grossFils: 6_000, feeFils: 150, netPayoutFils: 5_850 },
  });
  await runConsumerPass(pool, config);
  const before = await pool.query(
    `SELECT status FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(before.rows[0].status, "closed");

  // Payout flips the batch row to paid; the settlement.paid event emitted
  // on payout must re-sync the trend row through the same pass.
  const paidAt = new Date("2026-09-02T08:00:00Z");
  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = $1 WHERE id = $2`, [paidAt, batchId]);
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-01", grossFils: 6_000, feeFils: 150, netPayoutFils: 5_850 },
  });

  const { processedCount } = await runConsumerPass(pool, config);
  assert.ok(processedCount >= 1, "at least this test's settlement.paid event was processed");

  const after = await pool.query(
    `SELECT status, paid_at, gross_fils, fee_fils, net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].status, "paid");
  assert.equal(after.rows[0].paid_at.toISOString(), paidAt.toISOString());
  assert.equal(Number(after.rows[0].gross_fils), 6_000);
  assert.equal(Number(after.rows[0].fee_fils), 150);
  assert.equal(Number(after.rows[0].net_payout_fils), 5_850);
});

// MK: this is the proof exactly-once holds.
test("runConsumerPass: atomicity — an apply failure partway through a multi-event batch rolls back the WHOLE pass, neither watermark nor any rollup write from that batch persists", async () => {
  const merchantId = await createMerchant("atomicity");

  // Event 1: valid, would successfully write a merchant_daily_volume row if
  // applied on its own.
  const goodEvent = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_234, feeFils: 18, newStatus: "captured", capturedTotalFils: 1_234 },
  });

  // Event 2: malformed — missing merchantId entirely, so
  // applyTransactionVoided's INSERT sends a NULL into
  // merchant_daily_volume.merchant_id, violating its NOT NULL constraint
  // and throwing partway through the batch (event 2 of 2, ordered by id).
  const badEvent = await enqueueEvent(pool, {
    eventType: "transaction.voided",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: {}, // no merchantId
  });
  assert.ok(badEvent.id > goodEvent.id, "bad event sorts after the good one, so the good one is applied first");

  const cursorBefore = await getCursor();

  await assert.rejects(runConsumerPass(pool, config));

  const cursorAfter = await getCursor();
  assert.equal(cursorAfter, cursorBefore, "watermark must be completely untouched after a rolled-back pass");

  const volumeRows = await pool.query(`SELECT * FROM merchant_daily_volume WHERE merchant_id = $1`, [merchantId]);
  assert.equal(volumeRows.rows.length, 0, "the good event's rollup write must NOT have persisted — the whole pass rolled back");

  // Prove the pass is retryable and self-heals once the poisoned row is no
  // longer in the way: delete the malformed event, retry, and confirm the
  // good event (still unprocessed, since the watermark never advanced past
  // it) is now correctly applied.
  await pool.query(`DELETE FROM outbox_events WHERE id = $1`, [badEvent.id]);
  const retryResult = await runConsumerPass(pool, config);
  assert.ok(retryResult.processedCount >= 1);

  const volumeRowsAfterRetry = await pool.query(`SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(volumeRowsAfterRetry.rows.length, 1);
  assert.equal(volumeRowsAfterRetry.rows[0].captured_count, 1);

  const cursorFinal = await getCursor();
  assert.ok(cursorFinal >= goodEvent.id, "watermark now past the previously-blocked good event");
});
