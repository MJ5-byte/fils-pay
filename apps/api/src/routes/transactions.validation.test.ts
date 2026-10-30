/**
 * Route-level tests for transaction list/export input validation and the
 * paginated export, against a real, migrated Postgres (run `npm run migrate`
 * first). Covers BHA-82 (invalid date range returned 500 instead of 400) and
 * BHA-84 (export loaded the whole result into memory via an unbounded SELECT;
 * it now streams page by page).
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
    "transactions.validation.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
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
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
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

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

// BHA-82
test("GET /v1/transactions with an invalid from date returns 400, not 500", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("list-bad-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions?from=notadate",
    headers: authHeader(rawKey),
  });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");
  // The error body carries a clean message, never a stack trace or SQL.
  assert.ok(!/\bSELECT\b|at Object|node_modules/i.test(res.body));
});

// BHA-82
test("GET /v1/transactions/export with an invalid to date returns 400, not 500", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("export-bad-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export?to=2026-13-40",
    headers: authHeader(rawKey),
  });

  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");
});

// BHA-82: a valid date range still works.
test("GET /v1/transactions with a valid date range returns 200", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("list-good-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
    headers: authHeader(rawKey),
  });

  assert.equal(res.statusCode, 200, res.body);
});

// BHA-84: the streamed export returns every row across more than one page
// (PAGE_SIZE is 1000), proving the paginated path is wired and complete.
test("GET /v1/transactions/export streams the full result across the page boundary", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("export-large");
  const rowCount = 1001;

  await pool.query(
    `INSERT INTO transactions
       (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'ref-' || g, 'acq-' || g, now() - (g || ' seconds')::interval
       FROM generate_series(1, $2) AS g`,
    [merchantId, rowCount],
  );

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: authHeader(rawKey),
  });

  assert.equal(res.statusCode, 200, res.body);
  const lines = res.body.split("\n").filter((line) => line.length > 0);
  assert.equal(lines[0], "id,status,amount_bhd,captured_bhd,reference,occurred_at");
  // One header line plus one line per transaction: the export must span both
  // pages (PAGE_SIZE is 1000) and return every row exactly once.
  const dataLines = lines.slice(1);
  assert.equal(dataLines.length, rowCount);
  const references = new Set(dataLines.map((line) => line.split(",")[4]));
  assert.equal(references.size, rowCount);
});
