/**
 * The Redis read cache in front of the rollup analytics reads. The first test
 * needs no Redis; the second runs only when REDIS_URL points at a throwaway
 * Redis, and is skipped otherwise.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { connectCache, disconnectCache } from "../cache/redis.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("cache.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const redisUrl = process.env.REDIS_URL;

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.afterEach(async () => {
  await disconnectCache();
});
test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithVolumeRow(capturedCount: number): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Cache Test Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]?.id;
  assert.ok(merchantId);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = user.rows[0]?.id;
  assert.ok(ownerUserId);
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "cache" });

  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ('reporting', 1, now())
     ON CONFLICT (consumer_name) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count)
     VALUES ($1, '2026-01-10', $2, 1000, 0)`,
    [merchantId, capturedCount],
  );
  return { merchantId, rawKey };
}

async function capturedCount(rawKey: string): Promise<number | undefined> {
  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-02-01",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ points: Array<{ capturedCount: number }> }>();
  return body.points[0]?.capturedCount;
}

test("volumes still answer from the database when Redis is unreachable", async () => {
  // Nothing listens on port 1, so every cache call fails and must fall through.
  void connectCache("redis://127.0.0.1:1");
  const { rawKey } = await merchantWithVolumeRow(3);

  assert.equal(await capturedCount(rawKey), 3);
});

test("a captured event applied by the reporting worker invalidates the cached volumes", { skip: !redisUrl, timeout: 10_000 }, async () => {
  await connectCache(redisUrl);
  const { merchantId, rawKey } = await merchantWithVolumeRow(1);

  assert.equal(await capturedCount(rawKey), 1);
  // The cache's write is not awaited by the request; give it its round trip.
  await new Promise<void>((resolve) => setImmediate(resolve));

  // A rollup change without the worker's cursor advance: the cache still serves the old value.
  await pool.query(`UPDATE merchant_daily_volume SET captured_count = 2 WHERE merchant_id = $1`, [merchantId]);
  assert.equal(await capturedCount(rawKey), 1);

  // What runConsumerPass does for a transaction.captured event: the rollup
  // upsert and the cursor advance in one transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE merchant_daily_volume SET captured_count = 3 WHERE merchant_id = $1`, [merchantId]);
    await client.query(
      `UPDATE reporting_outbox_cursor SET last_processed_id = last_processed_id + 1, updated_at = now()
        WHERE consumer_name = 'reporting'`,
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  assert.equal(await capturedCount(rawKey), 3);
});
