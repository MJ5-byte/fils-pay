/**
 * Route-level tests for the analytics surface — volumes, payout-trends,
 * top-links — using `app.inject(...)` against `buildApp()` and a real,
 * migrated Postgres (no DB mocking), same shape as settlement.test.ts. The
 * reporting worker (apps/reporting) is not
 * run here — rollup rows are inserted directly via SQL, matching this
 * suite's own precedent (settlement.test.ts's closeAndPayoutBatch) of
 * building fixture state directly rather than shelling out to another
 * service's process.
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
    "analytics.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Analytics Test Merchant ${label} ${randomUUID()}`, 250],
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

async function ensureReportingCursor(): Promise<void> {
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ('reporting', 1, now())
     ON CONFLICT (consumer_name) DO UPDATE SET updated_at = now()`,
  );
}

async function insertVolumeRow(
  merchantId: string,
  volumeDate: string,
  fields: { capturedCount?: number; capturedGrossFils?: number; voidedCount?: number } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [merchantId, volumeDate, fields.capturedCount ?? 1, fields.capturedGrossFils ?? 1000, fields.voidedCount ?? 0],
  );
}

async function insertSettlementBatch(merchantId: string, batchDate: string, status: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, $2, $3, 5000, 100, 4900, now(), now())
     RETURNING id`,
    [merchantId, batchDate, status],
  );
  return result.rows[0]!.id;
}

async function insertPayoutTrendRow(merchantId: string, batchId: string, batchDate: string, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_payout_trends (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at)
     VALUES ($1, $2, $3, $4, 5000, 100, 4900, now())`,
    [merchantId, batchId, batchDate, status],
  );
}

async function insertPaidPaymentLink(
  merchantId: string,
  amountFils: number,
  paidAt: string,
): Promise<string> {
  const txnResult = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', $2, $2, $3) RETURNING id`,
    [merchantId, amountFils, `test-acq-ref-${randomUUID()}`],
  );
  const transactionId = txnResult.rows[0]!.id;

  const linkResult = await pool.query<{ id: string }>(
    `INSERT INTO payment_links
        (merchant_id, token, amount_fils, reference, description, status, expires_at, transaction_id,
         created_by_type, created_by_id, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'paid', now() + interval '1 day', $6, 'merchant_api_key', $7, $8)
     RETURNING id`,
    [merchantId, randomUUID(), amountFils, `ref-${randomUUID()}`, "test link", transactionId, randomUUID(), paidAt],
  );
  return linkResult.rows[0]!.id;
}

/** Inserts rollup rows directly; the reporting worker is not run, so a wedged consumer would not show up here. */
test("GET /v1/analytics/volumes: readModelAsOf/live present, date-range filters, merchant-scoped", async () => {
  await ensureReportingCursor();
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("volumes");
  const { merchantId: otherMerchantId, rawKey: otherRawKey } = await createApprovedMerchantWithApiKey("volumes-other");

  await insertVolumeRow(merchantId, "2026-01-10", { capturedCount: 3, capturedGrossFils: 9_000, voidedCount: 1 });
  await insertVolumeRow(merchantId, "2026-01-15", { capturedCount: 1, capturedGrossFils: 500 });
  // Outside the query window below — must never appear in the response.
  await insertVolumeRow(merchantId, "2026-03-01", { capturedCount: 99 });
  // A different merchant's row — must never appear in this merchant's response.
  await insertVolumeRow(otherMerchantId, "2026-01-10", { capturedCount: 42 });

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-02-01",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    points: Array<{ date: string; capturedCount: number; capturedGrossFils: number; voidedCount: number }>;
    readModelAsOf: string | null;
    live: boolean;
  };

  assert.equal(body.live, false);
  assert.ok(body.readModelAsOf, "readModelAsOf must be present");
  assert.equal(body.points.length, 2, "only the two in-window rows for this merchant");
  assert.deepEqual(
    body.points.map((p) => p.date),
    ["2026-01-10", "2026-01-15"],
  );
  const first = body.points[0]!;
  assert.equal(first.capturedCount, 3);
  assert.equal(first.capturedGrossFils, 9_000);
  assert.equal(first.voidedCount, 1);

  // Merchant scoping: the other merchant never sees this merchant's rows
  // and vice versa.
  const otherRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-02-01",
    headers: authHeader(otherRawKey),
  });
  const otherBody = otherRes.json() as { points: Array<{ capturedCount: number }> };
  assert.equal(otherBody.points.length, 1);
  assert.equal(otherBody.points[0]!.capturedCount, 42);
});

test("GET /v1/analytics/volumes: invalid date query params are rejected 400", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("volumes-invalid-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=not-a-date&to=2026-02-01",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");

  const res2 = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-13-40",
    headers: authHeader(rawKey),
  });
  assert.equal(res2.statusCode, 400, res2.body);
});

// BHA-163/164: an impossible but correctly-shaped date (Feb 30, Apr 31) used
// to slip past Date.parse (which normalizes it) and 500 inside Postgres. It
// must be rejected at the boundary with a clean 400.
test("GET /v1/analytics/volumes: an impossible date is rejected 400, not 500", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("volumes-impossible-date");

  const feb30 = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-02-30&to=2026-03-10",
    headers: authHeader(rawKey),
  });
  assert.equal(feb30.statusCode, 400, feb30.body);
  assert.equal(feb30.json().error, "invalid_date");

  const apr31 = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-04-31",
    headers: authHeader(rawKey),
  });
  assert.equal(apr31.statusCode, 400, apr31.body);
  assert.equal(apr31.json().error, "invalid_date");
});

test("GET /v1/analytics/volumes: default from/to window (no query params) succeeds and is a real 31-day window", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("volumes-default-window");

  const res = await app.inject({ method: "GET", url: "/v1/analytics/volumes", headers: authHeader(rawKey) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { points: unknown[]; live: boolean };
  assert.equal(body.live, false);
  assert.deepEqual(body.points, []);
});

test("GET /v1/analytics/payout-trends: readModelAsOf/live present, date-range filters, merchant-scoped", async () => {
  await ensureReportingCursor();
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("payout-trends");
  const { merchantId: otherMerchantId, rawKey: otherRawKey } = await createApprovedMerchantWithApiKey(
    "payout-trends-other",
  );

  const inWindowBatch = await insertSettlementBatch(merchantId, "2026-01-12", "paid");
  await insertPayoutTrendRow(merchantId, inWindowBatch, "2026-01-12", "paid");

  const outOfWindowBatch = await insertSettlementBatch(merchantId, "2026-05-01", "paid");
  await insertPayoutTrendRow(merchantId, outOfWindowBatch, "2026-05-01", "paid");

  const otherBatch = await insertSettlementBatch(otherMerchantId, "2026-01-12", "paid");
  await insertPayoutTrendRow(otherMerchantId, otherBatch, "2026-01-12", "paid");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/payout-trends?from=2026-01-01&to=2026-02-01",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    points: Array<{ settlementBatchId: string; batchDate: string; status: string; grossFils: number; feeFils: number; netPayoutFils: number }>;
    readModelAsOf: string | null;
    live: boolean;
  };
  assert.equal(body.live, false);
  assert.ok(body.readModelAsOf);
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0]!.settlementBatchId, inWindowBatch);
  assert.equal(body.points[0]!.status, "paid");
  assert.equal(body.points[0]!.grossFils, 5_000);
  assert.equal(body.points[0]!.feeFils, 100);
  assert.equal(body.points[0]!.netPayoutFils, 4_900);

  const otherRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/payout-trends?from=2026-01-01&to=2026-02-01",
    headers: authHeader(otherRawKey),
  });
  const otherBody = otherRes.json() as { points: Array<{ settlementBatchId: string }> };
  assert.equal(otherBody.points.length, 1);
  assert.equal(otherBody.points[0]!.settlementBatchId, otherBatch);
});

test("GET /v1/analytics/payout-trends: invalid date query params are rejected 400", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("payout-trends-invalid-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/payout-trends?from=2026-01-01&to=garbage",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");
});

test("GET /v1/analytics/top-links: always live:true with a fresh readModelAsOf, ranked by amount desc, merchant-scoped", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("top-links");
  const { merchantId: otherMerchantId, rawKey: otherRawKey } = await createApprovedMerchantWithApiKey("top-links-other");

  const paidAt = "2026-01-15T10:00:00Z";
  await insertPaidPaymentLink(merchantId, 3_000, paidAt);
  await insertPaidPaymentLink(merchantId, 9_000, paidAt);
  await insertPaidPaymentLink(merchantId, 1_000, paidAt);
  // Outside the query window — must never appear.
  await insertPaidPaymentLink(merchantId, 50_000, "2026-06-01T10:00:00Z");
  // A different merchant's link — must never appear in this merchant's response.
  await insertPaidPaymentLink(otherMerchantId, 99_000, paidAt);

  const beforeRequest = Date.now();
  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    links: Array<{ amountFils: number }>;
    readModelAsOf: string;
    live: boolean;
  };

  assert.equal(body.live, true);
  const readModelAsOfMs = new Date(body.readModelAsOf).getTime();
  assert.ok(readModelAsOfMs >= beforeRequest && readModelAsOfMs <= Date.now(), "readModelAsOf must be ~now for the live endpoint");

  assert.equal(body.links.length, 3, "only this merchant's in-window paid links");
  assert.deepEqual(
    body.links.map((l) => l.amountFils),
    [9_000, 3_000, 1_000],
    "ranked by amount_fils DESC",
  );

  const otherRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01",
    headers: authHeader(otherRawKey),
  });
  const otherBody = otherRes.json() as { links: Array<{ amountFils: number }> };
  assert.equal(otherBody.links.length, 1);
  assert.equal(otherBody.links[0]!.amountFils, 99_000);
});

test("GET /v1/analytics/top-links: limit is clamped to [1, 50], default 10", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("top-links-limit");
  const paidAt = "2026-01-15T10:00:00Z";
  for (let i = 0; i < 60; i++) {
    await insertPaidPaymentLink(merchantId, 1_000 + i, paidAt);
  }

  const defaultRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01",
    headers: authHeader(rawKey),
  });
  assert.equal((defaultRes.json() as { links: unknown[] }).links.length, 10, "default limit is 10");

  const overRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01&limit=1000",
    headers: authHeader(rawKey),
  });
  assert.equal((overRes.json() as { links: unknown[] }).links.length, 50, "clamped to the max of 50, never trusted past the cap");

  const underRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01&limit=0",
    headers: authHeader(rawKey),
  });
  assert.equal((underRes.json() as { links: unknown[] }).links.length, 1, "clamped up to the min of 1");

  const negativeRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-01-01&to=2026-02-01&limit=-5",
    headers: authHeader(rawKey),
  });
  assert.equal((negativeRes.json() as { links: unknown[] }).links.length, 1);
});

test("GET /v1/analytics/top-links: invalid date query params are rejected 400", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("top-links-invalid-date");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/top-links?from=2026-13-40&to=2026-03-01",
    headers: authHeader(rawKey),
  });
  // 2026-13-40 matches the YYYY-MM-DD shape but fails Date.parse's own
  // validity check (no 13th month, no 40th day).
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");
});

/** A balanced two-leg ledger group for `merchantId` at `occurredAt` — the
 *  balance trigger (0007) rejects anything that doesn't net to zero, so
 *  activity fixtures always post a debit/credit pair. */
async function insertLedgerPair(
  merchantId: string,
  occurredAt: string,
  amountFils: number,
  description: string,
): Promise<void> {
  const entryGroupId = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'debit',  $3, $4, $5),
            ($1, $2, 'merchant_payable',     'credit', $3, $4, $5)`,
    [entryGroupId, merchantId, amountFils, occurredAt, description],
  );
}

// checks inclusive `to` (BETWEEN). API.md says exclusive — one of them is wrong — am
test("GET /v1/analytics/recent-ledger-activity: live:true, Bahrain-day window filters, merchant-scoped", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("ledger-activity");
  const { merchantId: otherMerchantId, rawKey: otherRawKey } =
    await createApprovedMerchantWithApiKey("ledger-activity-other");

  await insertLedgerPair(merchantId, "2026-01-10T09:00:00Z", 4_500, "capture");
  await insertLedgerPair(merchantId, "2026-01-15T18:00:00Z", 1_250, "payout");
  // Outside the window below — must never appear in the response.
  await insertLedgerPair(merchantId, "2026-03-01T09:00:00Z", 99_000, "out of window");
  // A different merchant's activity — must never leak into this response.
  await insertLedgerPair(otherMerchantId, "2026-01-10T09:00:00Z", 7_000, "other merchant");

  const beforeRequest = Date.now();
  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-01-01&to=2026-01-31",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    points: Array<{
      id: string;
      accountId: string;
      direction: string;
      amountFils: number;
      occurredAt: string;
      description: string | null;
    }>;
    readModelAsOf: string;
    live: boolean;
  };

  assert.equal(body.live, true);
  const readModelAsOfMs = new Date(body.readModelAsOf).getTime();
  assert.ok(
    readModelAsOfMs >= beforeRequest && readModelAsOfMs <= Date.now(),
    "readModelAsOf must be ~now for a live endpoint",
  );

  // Two in-window groups, two legs each.
  assert.equal(body.points.length, 4, "only this merchant's in-window legs");
  assert.deepEqual(
    body.points.map((p) => p.description),
    ["payout", "payout", "capture", "capture"],
    "ordered by occurred_at DESC",
  );
  assert.ok(
    body.points.every((p) => p.direction === "debit" || p.direction === "credit"),
    "direction round-trips as the ledger's own enum",
  );
  const payoutLegs = body.points.filter((p) => p.description === "payout");
  assert.deepEqual(
    payoutLegs.map((p) => p.amountFils).sort(),
    [1_250, 1_250],
  );
  assert.deepEqual(
    payoutLegs.map((p) => p.accountId).sort(),
    ["card_scheme_clearing", "merchant_payable"],
  );

  const otherRes = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-01-01&to=2026-01-31",
    headers: authHeader(otherRawKey),
  });
  const otherBody = otherRes.json() as { points: Array<{ description: string | null }> };
  assert.equal(otherBody.points.length, 2);
  assert.ok(otherBody.points.every((p) => p.description === "other merchant"));
});

test("GET /v1/analytics/recent-ledger-activity: a merchant with no activity gets an empty list, not an error", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("ledger-activity-empty");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-01-01&to=2026-01-31",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { points: unknown[]; live: boolean };
  assert.deepEqual(body.points, []);
  assert.equal(body.live, true);
});

test("GET /v1/analytics/recent-ledger-activity: a large BIGINT amount_fils survives serialization exactly", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("ledger-activity-bigint");
  await insertLedgerPair(merchantId, "2026-01-10T09:00:00Z", 9_999_999_999, "large amount");

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-01-01&to=2026-01-31",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { points: Array<{ amountFils: number; id: string }> };
  assert.equal(body.points.length, 2);
  assert.ok(body.points.every((p) => p.amountFils === 9_999_999_999), "no precision loss on a BIGINT column");
  assert.ok(
    body.points.every((p) => typeof p.id === "string" && p.id.length > 0),
    "the BIGSERIAL id is carried as a string",
  );
});

test("GET /v1/analytics/recent-ledger-activity: requires merchant auth, and rejects an invalid date range", async () => {
  const unauthenticated = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity",
  });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);

  const { rawKey } = await createApprovedMerchantWithApiKey("ledger-activity-invalid-date");
  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-13-40&to=2026-03-01",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_date");
});
