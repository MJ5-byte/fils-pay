/**
 * Route-level tests for the reporting surface, using `app.inject(...)`
 * against `buildApp()` and a real, migrated Postgres (no DB mocking), same
 * shape as settlement.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "reporting.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function createApprovedMerchantWithApiKey(label: string) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`,
    [`Test Merchant ${label} ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = userResult.rows[0]!.id;

  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });

  return { merchantId, rawKey: issued.rawKey };
}

// BHA-46: the route had no auth preHandler, so request.merchantAuth was
// undefined and every call answered 500.
test("GET /v1/reporting/export-summary sums the caller's own daily volume", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("export-summary");
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils)
     VALUES ($1, '2026-10-01', 2, 12500), ($1, '2026-10-02', 1, 4750)`,
    [merchantId],
  );

  const res = await app.inject({
    method: "GET",
    url: "/v1/reporting/export-summary",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { totalDays: 2, grossFils: 12_500 + 4_750 });
});

test("GET /v1/reporting/export-summary without credentials answers 401", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401, res.body);
});

// BHA-91 / BHA-104: a malformed date used to be dropped silently (top-level) or reach Postgres (filter JSON).
test("GET /v1/reporting/transactions answers 400 for a malformed date or filter shape", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("bad-dates");
  const get = (qs: string) =>
    app.inject({ method: "GET", url: `/v1/reporting/transactions?${qs}`, headers: { authorization: `Bearer ${rawKey}` } });
  const filter = (f: unknown) => `filter=${encodeURIComponent(JSON.stringify(f))}`;

  assert.equal((await get("from=banana&to=banana")).statusCode, 400);
  assert.equal((await get(filter({ from: "banana" }))).statusCode, 400);
  assert.equal((await get(filter({ to: 12345 }))).statusCode, 400);
  assert.equal((await get(filter(null))).statusCode, 400);
  assert.equal((await get(filter({ from: "1" }))).statusCode, 400);
  assert.equal((await get("from=2026-02-30")).statusCode, 400);
  assert.equal((await get(filter({ to: "2026-04-31" }))).statusCode, 400);
  assert.equal((await get(filter({ merchantId: "abc" }))).statusCode, 400);
  assert.equal((await get(filter({ status: ["a"] }))).statusCode, 400);
  assert.equal((await get(filter({ from: "2026-10-01", to: "2026-10-31" }))).statusCode, 200);
});

// BHA-163: the listing was unbounded. The route must bound its response to the
// house default and honour an explicit, clamped ?limit.
test("GET /v1/reporting/saved-filters bounds its response and honours ?limit", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("saved-filters-limit");
  for (let i = 0; i < 30; i++) {
    await pool.query(
      `INSERT INTO reporting_saved_filters (merchant_id, name, filter_json) VALUES ($1, $2, '{}'::jsonb)`,
      [merchantId, `filter ${i}`],
    );
  }
  const list = (qs: string) =>
    app.inject({
      method: "GET",
      url: `/v1/reporting/saved-filters${qs}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });

  const defaulted = await list("");
  assert.equal(defaulted.statusCode, 200, defaulted.body);
  assert.equal((defaulted.json() as unknown[]).length, 25, "default listing is bounded to 25, not all 30");

  const limited = await list("?limit=5");
  assert.equal(limited.statusCode, 200, limited.body);
  assert.equal((limited.json() as unknown[]).length, 5, "the route honours ?limit");
});
