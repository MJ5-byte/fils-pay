/**
 * Tests for the acquirer async-callback processor. The insert path needs a
 * real transaction to reference, so this file requires DATABASE_URL to
 * point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { NotFoundError } from "../lib/errors.js";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "./callbacks.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "callbacks.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createTransaction(): Promise<{ merchantId: string; transactionId: string }> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Acquirer Callback Test Merchant ${randomUUID()}`, 250],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 50000, 50000, $2)
     RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );

  return { merchantId, transactionId: txnResult.rows[0]!.id };
}

function callbackFor(transactionId: string, callbackId: string): AcquirerCallbackInput {
  return {
    callbackId,
    type: "fraud_review.completed",
    transactionId,
    occurredAt: "2026-09-16T10:00:00.000Z",
    outcome: "cleared",
    note: "Manual review cleared; no further action needed.",
  };
}

test("applyAcquirerCallback throws NotFoundError for an unknown transaction id", async () => {
  await assert.rejects(
    () => applyAcquirerCallback(pool, callbackFor(randomUUID(), `acqcb_${randomUUID()}`)),
    (err: unknown) => err instanceof NotFoundError && err.code === "transaction_not_found",
  );
});

test("applyAcquirerCallback records the acquirer's verdict against the transaction's merchant", async () => {
  const { merchantId, transactionId } = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;

  await applyAcquirerCallback(pool, callbackFor(transactionId, callbackId));

  const rows = await pool.query<{
    transaction_id: string;
    merchant_id: string;
    callback_type: string;
    outcome: string;
    note: string;
  }>(
    `SELECT transaction_id, merchant_id, callback_type, outcome, note
       FROM acquirer_callback_notes WHERE callback_id = $1`,
    [callbackId],
  );

  assert.equal(rows.rowCount, 1);
  const row = rows.rows[0]!;
  assert.equal(row.transaction_id, transactionId);
  assert.equal(row.merchant_id, merchantId);
  assert.equal(row.callback_type, "fraud_review.completed");
  assert.equal(row.outcome, "cleared");
  assert.equal(row.note, "Manual review cleared; no further action needed.");
});

test("applyAcquirerCallback dedupes a redelivered callback: the same callback_id twice gives one note", async () => {
  const { transactionId } = await createTransaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const cb = callbackFor(transactionId, callbackId);

  await Promise.all([applyAcquirerCallback(pool, cb), applyAcquirerCallback(pool, cb)]);

  const rows = await pool.query(
    `SELECT id FROM acquirer_callback_notes WHERE callback_id = $1`,
    [callbackId],
  );
  assert.equal(rows.rowCount, 1);
});

test("withCallbackRetry retries a failing call up to maxAttempts, then rethrows the last error", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withCallbackRetry(
        async () => {
          attempts += 1;
          throw new Error(`attempt ${attempts} failed`);
        },
        { maxAttempts: 3, delayMs: 1 },
      ),
    /attempt 3 failed/,
  );
  assert.equal(attempts, 3);
});

test("withCallbackRetry stops at the first success and returns its result", async () => {
  let attempts = 0;
  const result = await withCallbackRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
      return "applied";
    },
    { maxAttempts: 3, delayMs: 1 },
  );

  assert.equal(result, "applied");
  assert.equal(attempts, 2);
});
