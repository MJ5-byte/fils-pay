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
import { toBahrainDateString } from "../bahrainDate.js";
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

  // Compared on the database clock: the container's clock can run a few ms ahead of Node's.
  const cursorRow = await pool.query<{ not_future: boolean }>(
    `SELECT updated_at <= now() AS not_future FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  assert.equal(cursorRow.rows[0]!.not_future, true);
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

test("runConsumerPass: an event committed after a higher id (a long settlement transaction) is still applied", async () => {
  const merchantId = await createMerchant("out-of-order");
  const capturePayload = { merchantId, amountCapturedFils: 1_000, feeFils: 15, newStatus: "captured", capturedTotalFils: 1_000 };

  // The slow writer takes the lower id first and commits last, the way
  // CloseBatch inserts its batch_closed event and then keeps working.
  const slowWriter = await pool.connect();
  try {
    await slowWriter.query("BEGIN");
    const lowEvent = await enqueueEvent(slowWriter, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: randomUUID(),
      payload: capturePayload,
    });
    const highEvent = await enqueueEvent(pool, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: randomUUID(),
      payload: capturePayload,
    });
    assert.ok(highEvent.id > lowEvent.id);

    await runConsumerPass(pool, config);
    await slowWriter.query("COMMIT");
  } catch (err) {
    await slowWriter.query("ROLLBACK");
    throw err;
  } finally {
    slowWriter.release();
  }
  await runConsumerPass(pool, config);

  const result = await pool.query(`SELECT captured_count, captured_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].captured_count, 2, "both captures are counted, including the one committed late");
  assert.equal(Number(result.rows[0].captured_gross_fils), 2_000);
});

/**
 * A pool whose clients run `around.before` just before the pass's first
 * outbox read and `around.after` just after it, so a test can place other
 * writers exactly inside the pass.
 */
function poolAroundFirstOutboxRead(around: { before: () => Promise<void>; after: () => Promise<void> }): Pool {
  let fired = false;
  return {
    async connect() {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      return Object.assign(Object.create(client) as typeof client, {
        query: async (...args: unknown[]) => {
          if (fired || typeof args[0] !== "string" || !args[0].includes("FROM outbox_events")) return query(...args);
          fired = true;
          await around.before();
          const result = await query(...args);
          await around.after();
          return result;
        },
        release: client.release.bind(client),
      });
    },
  } as unknown as Pool;
}

for (const lateWriterCommits of ["after the pass", "between the pass's outbox read and its gap check"] as const) {
  test(`runConsumerPass: a writer that starts inside a pass and commits ${lateWriterCommits} still has its event applied`, async () => {
    const merchantId = await createMerchant(`interleaving ${lateWriterCommits}`);
    const capturePayload = { merchantId, amountCapturedFils: 1_000, feeFils: 15, newStatus: "captured", capturedTotalFils: 1_000 };
    const lateWriter = await pool.connect();
    let lateWriterOpen = false;
    try {
      const hookedPool = poolAroundFirstOutboxRead({
        // The pass has started; a writer begins and takes the lower id, then
        // another writer commits the next id, before the outbox is read.
        before: async () => {
          await lateWriter.query("BEGIN");
          lateWriterOpen = true;
          await enqueueEvent(lateWriter, { eventType: "transaction.captured", aggregateType: "transaction", aggregateId: randomUUID(), payload: capturePayload });
          await enqueueEvent(pool, { eventType: "transaction.captured", aggregateType: "transaction", aggregateId: randomUUID(), payload: capturePayload });
        },
        after: async () => {
          if (lateWriterCommits === "after the pass") return;
          await lateWriter.query("COMMIT");
          lateWriterOpen = false;
        },
      });

      await runConsumerPass(hookedPool, config);
      if (lateWriterOpen) {
        await lateWriter.query("COMMIT");
        lateWriterOpen = false;
      }
    } finally {
      if (lateWriterOpen) await lateWriter.query("ROLLBACK");
      lateWriter.release();
    }
    await runConsumerPass(pool, config);

    const result = await pool.query(`SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`, [merchantId]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].captured_count, 2, "the late writer's capture is counted too");
  });
}

test("runConsumerPass: end-to-end settlement.paid moves a closed batch's payout trend to paid", async () => {
  const merchantId = await createMerchant("e2e-paid");
  const batchResult = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-02-02', 'closed', 8_000, 200, 7_800, now())
     RETURNING id`,
    [merchantId],
  );
  const batchId = batchResult.rows[0]!.id;
  await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-02-02", grossFils: 8_000, feeFils: 200, netPayoutFils: 7_800 },
  });
  await runConsumerPass(pool, config);

  // The payout happens later; settlement's EnqueuePayoutNotifications then
  // enqueues settlement.paid with exactly this payload.
  const paidAt = new Date("2026-02-03T09:00:00Z");
  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = $2 WHERE id = $1`, [batchId, paidAt]);
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-02-02", netPayoutFils: 7_800 },
  });
  await runConsumerPass(pool, config);

  const result = await pool.query(
    `SELECT status, paid_at, net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "paid");
  assert.equal(result.rows[0].paid_at.toISOString(), paidAt.toISOString());
  assert.equal(Number(result.rows[0].net_payout_fils), 7_800);
});

test("runConsumerPass: two overlapping passes (the worker and a catch-up run) apply each event once", async () => {
  const merchantId = await createMerchant("overlap");
  const capturedEvent = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 2_000, feeFils: 30, newStatus: "captured", capturedTotalFils: 2_000 },
  });
  const volumeDate = toBahrainDateString(capturedEvent.createdAt);

  // Hold an uncommitted insert of the rollup row both passes will write, so
  // both are guaranteed to be in flight together before either can finish.
  const blocker = await pool.connect();
  const passes: Promise<unknown>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`INSERT INTO merchant_daily_volume (merchant_id, volume_date) VALUES ($1, $2)`, [merchantId, volumeDate]);

    passes.push(runConsumerPass(pool, config), runConsumerPass(pool, config));
    for (let waiting = 0, polls = 0; waiting < 2 && polls < 1_000; polls++) {
      const result = await blocker.query<{ count: string }>(
        `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      waiting = Number(result.rows[0]?.count ?? 0);
    }
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await Promise.all(passes);

  const result = await pool.query(`SELECT captured_count, captured_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].captured_count, 1, "the capture is counted once, not once per pass");
  assert.equal(Number(result.rows[0].captured_gross_fils), 2_000);
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

test("runConsumerPass: refund.succeeded rolls into refund_count/refund_gross_fils on the Bahrain business day, once across repeated passes", async () => {
  const merchantId = await createMerchant("refund-rollup");
  const event = await enqueueEvent(pool, {
    eventType: "refund.succeeded",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, refundId: randomUUID(), amountFils: 750, feeReversedFils: 11, refundedTotalFils: 750, newStatus: "partially_refunded" },
  });
  // 22:30 UTC on the 5th is 01:30 on the 6th in Bahrain.
  await pool.query(`UPDATE outbox_events SET created_at = $2 WHERE id = $1`, [event.id, "2026-03-05T22:30:00Z"]);

  await runConsumerPass(pool, config);
  await runConsumerPass(pool, config);

  const result = await pool.query(
    `SELECT volume_date::text AS volume_date, refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].volume_date, "2026-03-06");
  assert.equal(result.rows[0].refund_count, 1);
  assert.equal(Number(result.rows[0].refund_gross_fils), 750);
});
