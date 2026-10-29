/**
 * Tests for effective-dated fee-rate resolution, against a real, migrated
 * Postgres (no DB mocking) — same as transactions.test.ts and
 * discountAdjustment.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { getEffectiveMdrBps } from "./feeSchedule.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "feeSchedule.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function insertMerchant(mdrBps: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Fee Schedule Test ${randomUUID()}`, mdrBps],
  );
  return result.rows[0]!.id;
}

async function insertSchedule(merchantId: string, mdrBps: number, effectiveFrom: string): Promise<void> {
  await pool.query(`INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, $2, $3)`, [
    merchantId,
    mdrBps,
    effectiveFrom,
  ]);
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

test("falls back to the merchant's own mdr_bps when no schedule row exists", async () => {
  const merchantId = await insertMerchant(250);
  const resolved = await withClient((client) => getEffectiveMdrBps(client, merchantId, new Date(), 250));
  assert.equal(resolved, 250);
});

/** effective_from <= asOf is inclusive: a capture at exactly the cutover instant gets the new rate. */
test("a single past-dated row applies from its effective_from onward, never before it", async () => {
  const merchantId = await insertMerchant(250);
  await insertSchedule(merchantId, 200, "2026-06-01T00:00:00Z");

  await withClient(async (client) => {
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-05-31T23:59:59Z"), 250), 250);
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-06-01T00:00:00Z"), 250), 200);
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-09-01T00:00:00Z"), 250), 200);
  });
});

// currentFeeScheduleDisplay.ts follows the same rule, so the admin page shows the rate charged here.
test("resolves by effective_from, not by which row was inserted most recently", async () => {
  const merchantId = await insertMerchant(250);
  // Inserted newest-first: a lookup keyed off insertion order rather than
  // effective_from would answer 165 for the pre-cutover instant below.
  await insertSchedule(merchantId, 165, "2026-09-06T12:00:00Z");
  await insertSchedule(merchantId, 180, "2026-01-01T00:00:00Z");

  await withClient(async (client) => {
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-09-01T12:00:00Z"), 250), 180);
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-09-06T12:00:00Z"), 250), 165);
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-10-01T00:00:00Z"), 250), 165);
  });
});

test("the seeded schedule fixture resolves 180bps inside its transaction window and 165bps after the cutover", async () => {
  const merchant = await pool.query<{ id: string }>(
    `SELECT id FROM merchants WHERE display_name = 'Beta Digital Services'`,
  );
  const merchantId = merchant.rows[0]?.id;
  if (!merchantId) {
    // Not seeded — nothing to assert against. The three tests above cover
    // the mechanism itself without any seed data.
    return;
  }
  const schedules = await pool.query(`SELECT 1 FROM fee_schedules WHERE merchant_id = $1`, [merchantId]);
  if (schedules.rowCount !== 2) return;

  await withClient(async (client) => {
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-09-01T12:00:00Z"), 180), 180);
    assert.equal(await getEffectiveMdrBps(client, merchantId, new Date("2026-09-10T00:00:00Z"), 180), 165);
  });
});
