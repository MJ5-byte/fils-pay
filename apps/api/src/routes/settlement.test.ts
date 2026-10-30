/**
 * Route-level tests for the settlement surface — batches
 * list/detail/transactions, and the reconciliation report — using
 * `app.inject(...)` against `buildApp()` and a real, migrated Postgres (no
 * DB mocking), same shape as transactions.test.ts.
 *
 * Getting a *closed and paid* settlement batch into the test DB: this
 * suite replicates apps/settlement's CloseBatch/PayoutBatch SQL directly
 * in a TS test helper (`closeAndPayoutBatch` below) rather than shelling
 * out to the
 * compiled Go binary. Chosen because it keeps this test suite
 * self-contained and independent of whether a Go toolchain/binary is
 * available in whatever environment runs `npm test` — the same posture
 * `npm test` already has for every other TS suite in this repo.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, subtractFils, toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "settlement.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Merchant ${label} ${randomUUID()}`, mdrBps],
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

  return { merchantId, ownerUserId, rawKey: issued.rawKey };
}

/** Inserts an authenticated session directly (bypassing the full
 *  password+OTP login flow, which this file doesn't need) for a
 *  merchant_user with the given role, and returns the raw cookie token. */
async function createSessionWithRole(merchantId: string, role: "owner" | "finance" | "support") {
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const userId = userResult.rows[0]!.id;

  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [userId, sha256Hex(rawToken)],
  );
  return rawToken;
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

function cookieHeader(rawToken: string) {
  return { cookie: `${config.cookieName}=${rawToken}` };
}

async function authorize(rawKey: string, amountFils: number, opts: { idempotencyKey?: string; reference?: string } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...authHeader(rawKey), "idempotency-key": opts.idempotencyKey ?? randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: opts.reference ?? "order-1" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; status: string; amountFils: number; capturedFils: number };
}

async function capture(rawKey: string, transactionId: string, body: { amountFils?: number } = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: body,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

/** Asia/Bahrain observes no DST (fixed UTC+3 since 1972) — mirrors both
 *  apps/settlement's Go `BusinessDayWindow` and settlement/query.ts's own
 *  `bahrainLocalMidnightUtc`. */
function bahrainLocalMidnightUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+03:00`);
}

/** Today's Asia/Bahrain calendar date, as YYYY-MM-DD, derived from the
 *  current instant shifted by the fixed +03:00 offset. */
function todayBahrainDateString(): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Adds one calendar day to a YYYY-MM-DD date string, treating it as a
 *  plain calendar value (never zone-shifting it) — the correct way to get
 *  "the next business date" for a `to` (exclusive) filter, as distinct
 *  from converting a business date to its Bahrain-midnight UTC instant. */
function addOneCalendarDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Replicates apps/settlement's CloseBatch then PayoutBatch directly in SQL: selects unbatched
 * captured/partially_captured transaction_events for merchantId within
 * businessDate's Asia/Bahrain window, recomputes fee PER EVENT (via the
 * same `applyRateFils` capture.ts and CloseBatch both use) then sums,
 * freezes the batch, marks events batched, writes truncated
 * scheme_export_lines, and posts the payout ledger legs.
 */
async function closeAndPayoutBatch(merchantId: string, businessDate: string): Promise<string> {
  const start = bahrainLocalMidnightUtc(businessDate);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  // In real operation the daemon runs CloseBatch+PayoutBatch for a
  // business day some time AFTER that day's window has closed
  // (DaemonRunDelayMinutes, applied on the NEXT business day) — so the
  // payout ledger legs' occurred_at naturally falls outside the business
  // day's own [start, end) window. This test helper mirrors that real
  // timing explicitly (rather than using `now()`, which would post the
  // payout legs within the SAME window as the captures if a test closes
  // and pays out immediately after capturing) so a reconciliation query
  // scoped to exactly one business day sees only that day's capture
  // activity, not a same-day payout reversal it would never see in
  // production.
  const payoutOccurredAt = new Date(end.getTime() + 12 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status)
     VALUES ($1, $2, 'open') ON CONFLICT (merchant_id, batch_date) DO NOTHING`,
    [merchantId, businessDate],
  );
  const batchRow = await pool.query<{ id: string }>(
    `SELECT id FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`,
    [merchantId, businessDate],
  );
  const batchId = batchRow.rows[0]!.id;

  const merchantRow = await pool.query<{ mdr_bps: number }>(`SELECT mdr_bps FROM merchants WHERE id = $1`, [
    merchantId,
  ]);
  const mdrBps = merchantRow.rows[0]!.mdr_bps;

  const eventsResult = await pool.query<{ id: string; transaction_id: string; amount_fils: string }>(
    `SELECT te.id, te.transaction_id, te.amount_fils
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE t.merchant_id = $1
        AND te.event_type IN ('captured', 'partially_captured')
        AND te.settlement_batch_id IS NULL
        AND te.occurred_at >= $2 AND te.occurred_at < $3
      ORDER BY te.transaction_id, te.occurred_at`,
    [merchantId, start, end],
  );

  const grossByTxn = new Map<string, number>();
  const feeByTxn = new Map<string, number>();
  const orderedTxnIds: string[] = [];
  let batchGross = 0;
  let batchFee = 0;
  const eventIds: string[] = [];

  for (const row of eventsResult.rows) {
    const amountFils = toFils(Number(row.amount_fils));
    const feeFils = Number(applyRateFils(amountFils, mdrBps));
    if (!grossByTxn.has(row.transaction_id)) {
      grossByTxn.set(row.transaction_id, 0);
      feeByTxn.set(row.transaction_id, 0);
      orderedTxnIds.push(row.transaction_id);
    }
    grossByTxn.set(row.transaction_id, grossByTxn.get(row.transaction_id)! + Number(amountFils));
    feeByTxn.set(row.transaction_id, feeByTxn.get(row.transaction_id)! + feeFils);
    batchGross += Number(amountFils);
    batchFee += feeFils;
    eventIds.push(row.id);
  }
  const netPayout = batchGross - batchFee;

  await pool.query(
    `UPDATE settlement_batches
        SET status = 'closed', gross_fils = $2, fee_fils = $3, net_payout_fils = $4, closed_at = now()
      WHERE id = $1`,
    [batchId, batchGross, batchFee, netPayout],
  );

  if (eventIds.length > 0) {
    await pool.query(`UPDATE transaction_events SET settlement_batch_id = $2 WHERE id = ANY($1::bigint[])`, [
      eventIds,
      batchId,
    ]);
  }

  for (let i = 0; i < orderedTxnIds.length; i++) {
    const txnId = orderedTxnIds[i]!;
    const gross = grossByTxn.get(txnId)!;
    const truncated = Math.floor(gross / 10) * 10; // TruncateToSchemeAmount, integer-only
    await pool.query(
      `INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
       VALUES ($1, $2, $3, $4)`,
      [batchId, txnId, truncated, i + 1],
    );
  }

  if (netPayout > 0) {
    const groupId = randomUUID();
    await pool.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable', 'debit',  $4, $5, 'settlement payout: batch paid'),
         ($1, $2, $3, 'platform_cash',    'credit', $4, $5, 'settlement payout: batch paid')`,
      [groupId, merchantId, batchId, netPayout, payoutOccurredAt],
    );
  }

  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = $2 WHERE id = $1`, [
    batchId,
    payoutOccurredAt,
  ]);

  await pool.query(
    `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
     VALUES ($1, 0, $2, now())
     ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 0, last_settlement_batch_id = $2, updated_at = now()`,
    [merchantId, batchId],
  );

  return batchId;
}

test("GET /v1/settlement/batches lists a merchant's own batches, scoped by merchant_id", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("batches-list", 250);
  const txn = await authorize(rawKey, 5_000);
  await capture(rawKey, txn.id);

  const businessDate = todayBahrainDateString();
  const batchId = await closeAndPayoutBatch(merchantId, businessDate);

  const res = await app.inject({ method: "GET", url: "/v1/settlement/batches", headers: authHeader(rawKey) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { batches: Array<{ id: string; status: string; grossFils: number }> };
  const found = body.batches.find((b) => b.id === batchId);
  assert.ok(found, "closed+paid batch must appear in the merchant's own batch list");
  assert.equal(found!.status, "paid");
  assert.equal(found!.grossFils, 5_000);
});

test("GET /v1/settlement/batches/:id returns detail with included transaction/event counts, 404 for another merchant's batch", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("batch-detail", 250);
  const txn = await authorize(rawKey, 7_500);
  await capture(rawKey, txn.id);
  const businessDate = todayBahrainDateString();
  const batchId = await closeAndPayoutBatch(merchantId, businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/batches/${batchId}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.id, batchId);
  assert.equal(body.status, "paid");
  assert.equal(body.grossFils, 7_500);
  assert.equal(body.includedTransactionCount, 1);
  assert.equal(body.includedEventCount, 1);

  // A different merchant must get 404, not 403 — an ownership mismatch
  // must be indistinguishable from "doesn't exist".
  const { rawKey: otherRawKey } = await createApprovedMerchantWithApiKey("batch-detail-other");
  const otherRes = await app.inject({
    method: "GET",
    url: `/v1/settlement/batches/${batchId}`,
    headers: authHeader(otherRawKey),
  });
  assert.equal(otherRes.statusCode, 404, otherRes.body);
});

test("GET /v1/settlement/batches/:id/transactions returns the truncated scheme-export line for the captured transaction", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("batch-txns", 250);
  // 4747 fils truncates to 4740 fils at the scheme-export boundary.
  const txn = await authorize(rawKey, 4_747);
  await capture(rawKey, txn.id);
  const businessDate = todayBahrainDateString();
  const batchId = await closeAndPayoutBatch(merchantId, businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/batches/${batchId}/transactions`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactions: Array<{ transactionId: string; schemeAmountFils: number; authorizedFils: number }> };
  assert.equal(body.transactions.length, 1);
  const line = body.transactions[0]!;
  assert.equal(line.transactionId, txn.id);
  assert.equal(line.schemeAmountFils, 4_740);
  assert.equal(line.authorizedFils, 4_747);
});

/** Fully batched = pending is 0, so this never exercises the float pending path. */
test("GET /v1/settlement/reconciliation reports gapFils === 0 for a fully-batched period", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("reconciliation", 250);
  const txn1 = await authorize(rawKey, 10_000);
  await capture(rawKey, txn1.id);
  const txn2 = await authorize(rawKey, 3_333);
  await capture(rawKey, txn2.id);

  const businessDate = todayBahrainDateString();
  await closeAndPayoutBatch(merchantId, businessDate);

  const nextDay = addOneCalendarDay(businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${businessDate}&to=${nextDay}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as {
    gapFils: number;
    explained: boolean;
    ledgerMerchantPayableNetFils: number;
    settlementNetPayoutFils: number;
    pendingUnbatchedFils: number;
  };

  assert.equal(report.pendingUnbatchedFils, 0, "every capture in the period was batched, nothing pending");
  assert.equal(report.gapFils, 0, "gapFils must be exactly zero once everything captured is batched");
  assert.equal(report.explained, true);

  // Sanity: the ledger and settlement figures that produced gapFils === 0
  // are themselves non-trivial (not just two zeros cancelling out).
  const expectedGross = 10_000 + 3_333;
  const expectedFee =
    Number(applyRateFils(toFils(10_000), 250)) + Number(applyRateFils(toFils(3_333), 250));
  const expectedNet = Number(subtractFils(toFils(expectedGross), toFils(expectedFee)));
  assert.equal(report.settlementNetPayoutFils, expectedNet);
  assert.equal(report.ledgerMerchantPayableNetFils, expectedNet);
});

// BHA-46: a window that covers both the capture day and the payout day saw the
// payout once as a merchant_payable debit and again in settlementNetPayoutFils.
test("GET /v1/settlement/reconciliation counts a payout once when the window includes the payout day", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("reconciliation-payout-in-window", 250);
  const txn = await authorize(rawKey, 10_000);
  await capture(rawKey, txn.id);

  const businessDate = todayBahrainDateString();
  // closeAndPayoutBatch posts the payout legs on the next business day.
  await closeAndPayoutBatch(merchantId, businessDate);
  const dayAfterPayout = addOneCalendarDay(addOneCalendarDay(businessDate));

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${businessDate}&to=${dayAfterPayout}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { gapFils: number; explained: boolean; settlementNetPayoutFils: number };

  const expectedNet = 10_000 - Number(applyRateFils(toFils(10_000), 250));
  assert.equal(report.settlementNetPayoutFils, expectedNet);
  assert.equal(report.gapFils, 0, "the payout must not be subtracted a second time");
  assert.equal(report.explained, true);
});

// merchant in this fixture has no discount and no schedule row, so the float path is exact here — MK
test("GET /v1/settlement/reconciliation with an unbatched capture reports it as pendingUnbatchedFils, not an unexplained gap", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("reconciliation-pending", 250);
  const txn = await authorize(rawKey, 2_000);
  await capture(rawKey, txn.id);
  // Deliberately do NOT close/pay a batch — this capture stays unbatched.

  const businessDate = todayBahrainDateString();
  const nextDay = addOneCalendarDay(businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${businessDate}&to=${nextDay}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { gapFils: number; explained: boolean; pendingUnbatchedFils: number; settlementNetPayoutFils: number };

  const expectedFee = Number(applyRateFils(toFils(2_000), 250));
  const expectedPending = 2_000 - expectedFee;

  assert.equal(report.settlementNetPayoutFils, 0, "nothing has been closed/paid yet");
  assert.equal(report.pendingUnbatchedFils, expectedPending);
  assert.equal(report.gapFils, 0, "the ledger movement is fully attributed to pendingUnbatchedFils, so the gap is still zero");
  assert.equal(report.explained, true);
});

// BHA-107: the pending fee must be priced with the same integer applyRateFils
// path capture.ts uses, not float math. 20 fils at 250 bps is exactly 0.5 fils:
// bankers rounding (applyRateFils, and so capture.ts's ledger) gives 0, while
// the old float Math.round gave 1, a spurious 1-fil gap on a correctly
// settled book.
test("GET /v1/settlement/reconciliation prices the pending fee with integer rounding, not float (BHA-107)", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("reconciliation-float", 250);
  const txn = await authorize(rawKey, 20);
  await capture(rawKey, txn.id);
  // Left unbatched on purpose, so the pending-pricing path runs.

  const businessDate = todayBahrainDateString();
  const nextDay = addOneCalendarDay(businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${businessDate}&to=${nextDay}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { gapFils: number; explained: boolean; pendingUnbatchedFils: number };

  // applyRateFils(20, 250) === 0, so capture.ts posts no fee leg and the
  // merchant_payable movement is the full 20 fils gross.
  assert.equal(Number(applyRateFils(toFils(20), 250)), 0);
  assert.equal(report.pendingUnbatchedFils, 20);
  assert.equal(report.gapFils, 0);
  assert.equal(report.explained, true);
});

// BHA-108: the pending fee must be priced off the effective-dated fee schedule
// in force at capture time (and the volume-tier bonus), exactly as capture.ts
// resolves it, not off the merchant's flat current mdr_bps. This merchant's
// schedule rate (180) differs from its mdr_bps (250), and it carries a
// negotiated discount, so the old flat+float path produced an unexplained gap.
test("GET /v1/settlement/reconciliation prices the pending fee off the dated schedule and discount (BHA-108)", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("reconciliation-schedule", 250);
  await pool.query(`UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, [merchantId]);
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 180, now() - interval '1 day')`,
    [merchantId],
  );

  const txn = await authorize(rawKey, 10_000);
  await capture(rawKey, txn.id);
  // Left unbatched on purpose.

  const businessDate = todayBahrainDateString();
  const nextDay = addOneCalendarDay(businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${businessDate}&to=${nextDay}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { gapFils: number; explained: boolean; pendingUnbatchedFils: number };

  // The authoritative ledger movement: gross - MDR fee (priced at the 180bps
  // schedule rate, tier bonus 0 in this DB) + negotiated discount reversal,
  // each step bankers-rounded independently, exactly as capture.ts +
  // applyCaptureDiscountAdjustment post it.
  const feeFils = Number(applyRateFils(toFils(10_000), 180));
  const discountFils = Number(applyRateFils(toFils(feeFils), 1000));
  const expectedPending = 10_000 - feeFils + discountFils;

  assert.equal(report.pendingUnbatchedFils, expectedPending);
  assert.equal(report.gapFils, 0);
  assert.equal(report.explained, true);
});

test("GET /v1/settlement/summary sums captured amounts for transactions with a single capture event", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("summary-single-event", 250);
  const txn1 = await authorize(rawKey, 10_000);
  await capture(rawKey, txn1.id);
  const txn2 = await authorize(rawKey, 3_333);
  await capture(rawKey, txn2.id);

  const businessDate = todayBahrainDateString();
  const nextDay = addOneCalendarDay(businessDate);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/summary?from=${businessDate}&to=${nextDay}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionCount: number; totalCapturedFils: number };
  assert.equal(body.transactionCount, 2);
  assert.equal(body.totalCapturedFils, 10_000 + 3_333);
});

// BHA-27: the summary summed the running transactions.captured_fils once per
// capture event, so a transaction captured in two parts counted twice.
test("GET /v1/settlement/summary counts a transaction captured in two parts once", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("summary-two-captures", 250);
  const txn = await authorize(rawKey, 10_000);
  await capture(rawKey, txn.id, { amountFils: 4_000 });
  await capture(rawKey, txn.id, { amountFils: 6_000 });

  const businessDate = todayBahrainDateString();
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/summary?from=${businessDate}&to=${addOneCalendarDay(businessDate)}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionCount: number; totalCapturedFils: number };
  assert.equal(body.transactionCount, 1);
  assert.equal(body.totalCapturedFils, 10_000);
});

test("GET /v1/settlement/summary leaves out the part of a transaction captured before the window", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("summary-capture-outside-window", 250);
  const txn = await authorize(rawKey, 10_000);
  await capture(rawKey, txn.id, { amountFils: 3_000 });
  await pool.query(
    `UPDATE transaction_events SET occurred_at = occurred_at - interval '2 days'
      WHERE transaction_id = $1 AND event_type = 'partially_captured'`,
    [txn.id],
  );
  await capture(rawKey, txn.id, { amountFils: 2_000 });

  const businessDate = todayBahrainDateString();
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/summary?from=${businessDate}&to=${addOneCalendarDay(businessDate)}`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionCount: number; totalCapturedFils: number };
  assert.equal(body.transactionCount, 1);
  assert.equal(body.totalCapturedFils, 2_000);
});

test("GET /v1/settlement/summary is forbidden for a 'support' session role", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("summary-role");
  const supportToken = await createSessionWithRole(merchantId, "support");

  const res = await app.inject({
    method: "GET",
    url: "/v1/settlement/summary?from=2026-01-01&to=2026-01-02",
    headers: cookieHeader(supportToken),
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("GET /v1/settlement/summary succeeds for a 'finance' session role", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("summary-finance-role");
  const financeToken = await createSessionWithRole(merchantId, "finance");

  const res = await app.inject({
    method: "GET",
    url: "/v1/settlement/summary?from=2026-01-01&to=2026-01-02",
    headers: cookieHeader(financeToken),
  });
  assert.equal(res.statusCode, 200, res.body);
});

test("GET /v1/settlement/reconciliation is forbidden for a 'support' session role", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("reconciliation-role");
  const supportToken = await createSessionWithRole(merchantId, "support");

  const res = await app.inject({
    method: "GET",
    url: "/v1/settlement/reconciliation?from=2026-01-01&to=2026-01-02",
    headers: cookieHeader(supportToken),
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("GET /v1/settlement/reconciliation succeeds for a 'finance' session role", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("reconciliation-finance-role");
  const financeToken = await createSessionWithRole(merchantId, "finance");

  const res = await app.inject({
    method: "GET",
    url: "/v1/settlement/reconciliation?from=2026-01-01&to=2026-01-02",
    headers: cookieHeader(financeToken),
  });
  assert.equal(res.statusCode, 200, res.body);
});

// BHA-91: malformed ids, dates, limit and cursor must answer 4xx, never 500.
test("settlement routes answer 4xx for malformed id, dates, limit and cursor", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("bad-input");
  const get = (url: string) => app.inject({ method: "GET", url, headers: authHeader(rawKey) });

  assert.equal((await get("/v1/settlement/batches/not-a-uuid")).statusCode, 404);
  assert.equal((await get("/v1/settlement/batches/not-a-uuid/transactions")).statusCode, 404);
  assert.equal((await get("/v1/settlement/batches?from=banana")).statusCode, 400);
  assert.equal((await get("/v1/settlement/batches?to=banana")).statusCode, 400);
  assert.equal((await get("/v1/settlement/batches?limit=abc")).statusCode, 400);
  const crafted = Buffer.from("not-a-date|not-a-uuid", "utf8").toString("base64url");
  assert.equal((await get(`/v1/settlement/batches?cursor=${crafted}`)).statusCode, 400);
  for (const path of ["reconciliation", "summary"]) {
    assert.equal((await get(`/v1/settlement/${path}?from=banana&to=2026-10-02`)).statusCode, 400, path);
    assert.equal((await get(`/v1/settlement/${path}?from=2026-10-01&to=2026-02-30`)).statusCode, 400, path);
  }
});
