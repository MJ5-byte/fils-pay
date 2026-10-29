/**
 * Unit-ish tests for applyEvent's per-event-type appliers:
 * assert rollup rows after applying a
 * hand-constructed outbox event row, and prove applyBatchClosed's
 * ON CONFLICT DO UPDATE is safe to re-invoke without drift. Requires
 * DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyEvent.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`applyEvent Test Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function createSettlementBatch(
  merchantId: string,
  opts: { status?: string; paidAt?: Date | null } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, $2, $3, 0, 0, 0, now(), $4)
     RETURNING id`,
    [merchantId, "2026-01-05", opts.status ?? "closed", opts.paidAt ?? null],
  );
  return result.rows[0]!.id;
}

function makeRow(overrides: Partial<OutboxEventRow> & Pick<OutboxEventRow, "event_type" | "payload">): OutboxEventRow {
  return {
    id: 1,
    aggregate_id: randomUUID(),
    created_at: new Date("2026-01-05T10:00:00Z"), // Asia/Bahrain 13:00 -> volume_date 2026-01-05
    ...overrides,
  };
}

test("applyTransactionCaptured (via applyEvent): creates a merchant_daily_volume row summing amountCapturedFils, bucketed by Asia/Bahrain date from outbox created_at", async () => {
  const merchantId = await createMerchant("captured");
  const row = makeRow({
    event_type: "transaction.captured",
    payload: { merchantId, amountCapturedFils: 4_750, feeFils: 71, newStatus: "captured", capturedTotalFils: 4_750 },
  });

  await withTransaction(pool, (client) => applyEvent(client, row));

  const result = await pool.query(
    `SELECT captured_count, captured_gross_fils, voided_count FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = '2026-01-05'`,
    [merchantId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].captured_count, 1);
  assert.equal(Number(result.rows[0].captured_gross_fils), 4_750);
  assert.equal(result.rows[0].voided_count, 0);
});

test("applyTransactionCaptured (via applyEvent): a second captured event for the same merchant/day accumulates, not overwrites", async () => {
  const merchantId = await createMerchant("captured-accumulate");
  const row1 = makeRow({
    event_type: "transaction.captured",
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 15, newStatus: "captured", capturedTotalFils: 1_000 },
  });
  const row2 = makeRow({
    event_type: "transaction.captured",
    payload: { merchantId, amountCapturedFils: 2_500, feeFils: 37, newStatus: "captured", capturedTotalFils: 2_500 },
  });

  await withTransaction(pool, (client) => applyEvent(client, row1));
  await withTransaction(pool, (client) => applyEvent(client, row2));

  const result = await pool.query(
    `SELECT captured_count, captured_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = '2026-01-05'`,
    [merchantId],
  );
  assert.equal(result.rows[0].captured_count, 2);
  assert.equal(Number(result.rows[0].captured_gross_fils), 3_500);
});

test("applyTransactionVoided (via applyEvent): increments voided_count, leaves captured_gross_fils untouched (no amount in the void payload)", async () => {
  const merchantId = await createMerchant("voided");
  const capturedRow = makeRow({
    event_type: "transaction.captured",
    payload: { merchantId, amountCapturedFils: 500, feeFils: 7, newStatus: "captured", capturedTotalFils: 500 },
  });
  const voidedRow = makeRow({
    event_type: "transaction.voided",
    payload: { merchantId },
  });

  await withTransaction(pool, (client) => applyEvent(client, capturedRow));
  await withTransaction(pool, (client) => applyEvent(client, voidedRow));

  const result = await pool.query(
    `SELECT captured_count, captured_gross_fils, voided_count FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = '2026-01-05'`,
    [merchantId],
  );
  assert.equal(result.rows[0].captured_count, 1);
  assert.equal(Number(result.rows[0].captured_gross_fils), 500);
  assert.equal(result.rows[0].voided_count, 1);
});

test("applyBatchClosed (via applyEvent): creates a merchant_payout_trends row copying settlement_batches' status/paid_at as of application time", async () => {
  const merchantId = await createMerchant("batch-closed");
  const paidAt = new Date("2026-01-06T12:00:00Z");
  const batchId = await createSettlementBatch(merchantId, { status: "paid", paidAt });
  const row = makeRow({
    event_type: "settlement.batch_closed",
    payload: { merchantId, batchId, batchDate: "2026-01-05", grossFils: 10_000, feeFils: 250, netPayoutFils: 9_750 },
  });

  await withTransaction(pool, (client) => applyEvent(client, row));

  const result = await pool.query(
    `SELECT status, gross_fils, fee_fils, net_payout_fils, paid_at FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "paid");
  assert.equal(Number(result.rows[0].gross_fils), 10_000);
  assert.equal(Number(result.rows[0].fee_fils), 250);
  assert.equal(Number(result.rows[0].net_payout_fils), 9_750);
  assert.equal(result.rows[0].paid_at.toISOString(), paidAt.toISOString());
});

// FH: covers no batch row. anything cover a missing rollup row? claude: "Yes, the next test covers it."
test("applyBatchClosed (via applyEvent): a missing settlement_batches row is a no-op, never throws", async () => {
  const merchantId = await createMerchant("batch-closed-missing");
  const row = makeRow({
    event_type: "settlement.batch_closed",
    payload: {
      merchantId,
      batchId: randomUUID(), // no such settlement_batches row exists
      batchDate: "2026-01-05",
      grossFils: 1,
      feeFils: 0,
      netPayoutFils: 1,
    },
  });

  await assert.doesNotReject(withTransaction(pool, (client) => applyEvent(client, row)));

  const result = await pool.query(`SELECT count(*) FROM merchant_payout_trends WHERE merchant_id = $1`, [merchantId]);
  assert.equal(Number(result.rows[0].count), 0);
});

test("applyBatchClosed (via applyEvent): a day with real capture activity whose rollup already matches ground truth is silent and safe", async () => {
  const merchantId = await createMerchant("batch-closed-rollup-parity");
  const batchId = await createSettlementBatch(merchantId, { status: "closed", paidAt: null });

  // One real captured transaction + its transaction_events row (ground
  // truth), occurring inside Asia/Bahrain's 2026-01-05 local day.
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 4750, 4750, $2, '2026-01-05T10:00:00Z')
     RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'captured', 4750, 'system', '2026-01-05T10:00:00Z')`,
    [txnResult.rows[0]!.id],
  );

  // The matching rollup row, produced the same way the real consumer
  // produces it: by applying the capture's own outbox event first.
  await withTransaction(pool, (client) =>
    applyEvent(
      client,
      makeRow({
        event_type: "transaction.captured",
        payload: { merchantId, amountCapturedFils: 4_750, feeFils: 71, newStatus: "captured", capturedTotalFils: 4_750 },
      }),
    ),
  );

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await assert.doesNotReject(
      withTransaction(pool, (client) =>
        applyEvent(
          client,
          makeRow({
            event_type: "settlement.batch_closed",
            payload: { merchantId, batchId, batchDate: "2026-01-05", grossFils: 4_750, feeFils: 119, netPayoutFils: 4_631 },
          }),
        ),
      ),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [], "a rollup that matches ground truth must not warn");

  const result = await pool.query(
    `SELECT net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(Number(result.rows[0].net_payout_fils), 4_631);
});

test("applyBatchClosed (via applyEvent): a day with real capture activity but no rollup row yet warns instead of throwing, and still records the trend", async () => {
  const merchantId = await createMerchant("batch-closed-missing-rollup");
  const batchId = await createSettlementBatch(merchantId, { status: "closed", paidAt: null });

  // Ground truth has a capture on 2026-01-05, but its outbox event was never
  // applied, so merchant_daily_volume has no row for that merchant/day.
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 4750, 4750, $2, '2026-01-05T10:00:00Z')
     RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'captured', 4750, 'system', '2026-01-05T10:00:00Z')`,
    [txnResult.rows[0]!.id],
  );

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await assert.doesNotReject(
      withTransaction(pool, (client) =>
        applyEvent(
          client,
          makeRow({
            event_type: "settlement.batch_closed",
            payload: { merchantId, batchId, batchDate: "2026-01-05", grossFils: 4_750, feeFils: 119, netPayoutFils: 4_631 },
          }),
        ),
      ),
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1, "a missing rollup row lags ground truth, so it warns once");
  assert.match(String(warnings[0]![0]), /rollup=0 ground_truth=1/);

  const result = await pool.query(
    `SELECT net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(Number(result.rows[0].net_payout_fils), 4_631);
});

test("applyBatchClosed (via applyEvent) is idempotent: applying the identical event twice produces no duplicate row and no drift", async () => {
  const merchantId = await createMerchant("batch-closed-idempotent");
  const batchId = await createSettlementBatch(merchantId, { status: "closed", paidAt: null });
  const row = makeRow({
    event_type: "settlement.batch_closed",
    payload: { merchantId, batchId, batchDate: "2026-01-05", grossFils: 5_000, feeFils: 125, netPayoutFils: 4_875 },
  });

  await withTransaction(pool, (client) => applyEvent(client, row));
  await withTransaction(pool, (client) => applyEvent(client, row));
  await withTransaction(pool, (client) => applyEvent(client, row));

  const result = await pool.query(
    `SELECT status, gross_fils, fee_fils, net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1, "no duplicate row after three identical applications");
  assert.equal(result.rows[0].status, "closed");
  assert.equal(Number(result.rows[0].gross_fils), 5_000);
  assert.equal(Number(result.rows[0].fee_fils), 125);
  assert.equal(Number(result.rows[0].net_payout_fils), 4_875);
});
