/**
 * Tests for the admin "Recompute statuses" tool, against a real, migrated
 * Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { recomputeTransactionStatusesForMerchant } from "./transactionStatusRecompute.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "transactionStatusRecompute.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createMerchant(testMode: boolean): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', $2) RETURNING id`,
    [`recompute-merchant-${randomUUID()}`, testMode],
  );
  return result.rows[0]!.id;
}

async function insertTransaction(
  merchantId: string,
  status: string,
  amountFils: number,
  capturedFils: number,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [merchantId, status, amountFils, capturedFils, `recompute-${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** Runs the tool the way `routes/adminMerchantsRecompute.ts` does. */
async function runRecompute(merchantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recompute = await recomputeTransactionStatusesForMerchant(client, merchantId);
    await client.query("COMMIT");
    return recompute;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function testMode(merchantId: string): Promise<boolean> {
  const result = await pool.query<{ test_mode: boolean }>(
    `SELECT test_mode FROM merchants WHERE id = $1`,
    [merchantId],
  );
  return result.rows[0]!.test_mode;
}

async function statusOf(transactionId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE id = $1`,
    [transactionId],
  );
  return result.rows[0]!.status;
}

test("a recompute counts authorized transactions and leaves them authorized", async () => {
  const merchantId = await createMerchant(true);
  const authorizedId = await insertTransaction(merchantId, "authorized", 5_000, 0);
  await insertTransaction(merchantId, "captured", 3_000, 3_000);

  const result = await runRecompute(merchantId);

  assert.equal(result.openAuthorizations, 1);
  assert.equal(await testMode(merchantId), true);
  assert.equal(await statusOf(authorizedId), "authorized");
});

test("a recompute leaves charged-back transactions as chargeback", async () => {
  const merchantId = await createMerchant(false);
  const chargebackId = await insertTransaction(merchantId, "chargeback", 4_000, 4_000);

  const result = await runRecompute(merchantId);

  assert.equal(result.updated, 0);
  assert.equal(await statusOf(chargebackId), "chargeback");
});

test("a recompute still corrects a captured transaction whose status drifted", async () => {
  const merchantId = await createMerchant(false);
  const driftedId = await insertTransaction(merchantId, "captured", 4_000, 1_000);

  const result = await runRecompute(merchantId);

  assert.equal(result.updated, 1);
  assert.equal(await statusOf(driftedId), "partially_captured");
});
