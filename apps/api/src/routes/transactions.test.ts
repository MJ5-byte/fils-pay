/**
 * Route-level tests for the transactions surface — authorize, capture,
 * void, and reads — using `app.inject(...)` against `buildApp()` and a
 * real, migrated Postgres (no DB mocking). Requires `DATABASE_URL` (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "transactions.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

// Deterministic, fast, always-approved acquirer for these tests: failure
// rate 0 and near-zero latency. Card-declined/error paths are exercised via
// the acquirer simulator's own magic PANs where a test needs them.
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

/** Inserts a merchant directly (bypassing the full signup flow, which this
 *  file doesn't need) and approves it through the real recordKycReview()
 *  write path, then issues a real API key for it. */
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

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
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

async function capture(
  rawKey: string,
  transactionId: string,
  body: { amountFils?: number } = {},
  idempotencyKey: string = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": idempotencyKey },
    payload: body,
  });
}

/** Inserts an authenticated session directly (bypassing the password+OTP
 *  login flow) for a new merchant_user with the given role, and returns the
 *  raw cookie token. */
async function createSessionWithRole(merchantId: string, role: "owner" | "finance" | "support") {
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [userResult.rows[0]!.id, sha256Hex(rawToken)],
  );
  return rawToken;
}

function cookieHeader(rawToken: string) {
  return { cookie: `${config.cookieName}=${rawToken}` };
}

test("authorize -> capture (full) happy path posts correct, balanced ledger legs", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("full-capture", 250);
  const txn = await authorize(rawKey, 10_000);
  assert.equal(txn.status, "authorized");
  assert.equal(txn.amountFils, 10_000);
  assert.equal(txn.capturedFils, 0);

  const preLedger = await pool.query(`SELECT COUNT(*)::int AS c FROM ledger_entries WHERE transaction_id = $1`, [
    txn.id,
  ]);
  assert.equal(preLedger.rows[0]!.c, 0);

  const captureRes = await capture(rawKey, txn.id);
  assert.equal(captureRes.statusCode, 200, captureRes.body);
  const captureBody = captureRes.json();
  assert.equal(captureBody.status, "captured");
  assert.equal(captureBody.capturedFils, 10_000);

  // 2.50% MDR on 10,000 fils = 250 fils fee (bankers rounding, exact here).
  const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(legs.rows.length, 4);
  const byLeg = new Map(legs.rows.map((r) => [`${r.account_id}:${r.direction}`, Number(r.amount_fils)]));
  assert.equal(byLeg.get("card_scheme_clearing:debit"), 10_000);
  assert.equal(byLeg.get("merchant_payable:credit"), 10_000);
  assert.equal(byLeg.get("merchant_payable:debit"), 250);
  assert.equal(byLeg.get("platform_fee_revenue:credit"), 250);

  const groupIds = new Set(
    (await pool.query<{ entry_group_id: string }>(`SELECT DISTINCT entry_group_id FROM ledger_entries WHERE transaction_id = $1`, [txn.id]))
      .rows.map((r) => r.entry_group_id),
  );
  assert.equal(groupIds.size, 1, "all four legs share one entry_group_id");

  const hold = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [txn.id]);
  assert.equal(hold.rows[0]!.status, "released");
});

test("authorize -> capture (partial) -> capture (remainder) transitions status correctly", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("partial-capture");
  const txn = await authorize(rawKey, 10_000);

  const partialRes = await capture(rawKey, txn.id, { amountFils: 4_000 });
  assert.equal(partialRes.statusCode, 200, partialRes.body);
  const partialBody = partialRes.json();
  assert.equal(partialBody.status, "partially_captured");
  assert.equal(partialBody.capturedFils, 4_000);

  const holdMid = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [txn.id]);
  assert.equal(holdMid.rows[0]!.status, "active");

  const remainderRes = await capture(rawKey, txn.id);
  assert.equal(remainderRes.statusCode, 200, remainderRes.body);
  const remainderBody = remainderRes.json();
  assert.equal(remainderBody.status, "captured");
  assert.equal(remainderBody.capturedFils, 10_000);

  const holdEnd = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [txn.id]);
  assert.equal(holdEnd.rows[0]!.status, "released");
});

test("authorize -> void happy path releases the hold and transitions to voided", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("void-happy");
  const txn = await authorize(rawKey, 5_000);

  const voidRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/void`,
    headers: authHeader(rawKey),
  });
  assert.equal(voidRes.statusCode, 200, voidRes.body);
  assert.equal(voidRes.json().status, "voided");

  const hold = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [txn.id]);
  assert.equal(hold.rows[0]!.status, "released");
});

test("void on an already-captured transaction is rejected 409", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("void-after-capture");
  const txn = await authorize(rawKey, 3_000);
  const captureRes = await capture(rawKey, txn.id);
  assert.equal(captureRes.statusCode, 200, captureRes.body);

  const voidRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/void`,
    headers: authHeader(rawKey),
  });
  assert.equal(voidRes.statusCode, 409, voidRes.body);
  assert.equal(voidRes.json().error, "not_voidable");
});

test("capture with a reused idempotency key and identical body replays without a second ledger entry", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("idempotent-replay");
  const txn = await authorize(rawKey, 8_000);
  const key = randomUUID();

  const first = await capture(rawKey, txn.id, {}, key);
  assert.equal(first.statusCode, 200, first.body);

  const countAfterFirst = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ledger_entries WHERE transaction_id = $1`,
    [txn.id],
  );

  const second = await capture(rawKey, txn.id, {}, key);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());

  const countAfterSecond = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM ledger_entries WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(Number(countAfterSecond.rows[0]!.c), Number(countAfterFirst.rows[0]!.c));
  assert.ok(Number(countAfterFirst.rows[0]!.c) > 0);
});

test("a capture whose discount adjustment fails commits nothing, and a same-key retry captures with the rebate", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("discount-adjustment-retry");
  await pool.query(`UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, [merchantId]);
  const txn = await authorize(rawKey, 10_000);
  const key = randomUUID();
  const suffix = randomUUID().replace(/-/g, "");
  const fn = `bha224_fail_${suffix}`;
  await pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.transaction_id = '${txn.id}' AND NEW.description = 'capture: negotiated discount adjustment' THEN
         RAISE EXCEPTION 'injected discount adjustment failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  try {
    await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`);

    // The rebate posts in the capture's own transaction (BHA-235), so its
    // failure rolls the capture back instead of committing the fee in full.
    const first = await capture(rawKey, txn.id, {}, key);
    assert.equal(first.statusCode, 500, first.body);

    const beforeReplay = await pool.query<{ status: string; c: number }>(
      `SELECT t.status, (SELECT COUNT(*)::int FROM ledger_entries l WHERE l.transaction_id = t.id) AS c
         FROM transactions t WHERE t.id = $1`,
      [txn.id],
    );
    assert.deepEqual(beforeReplay.rows[0], { status: "authorized", c: 0 });

    await pool.query(`DROP TRIGGER ${fn} ON ledger_entries`);

    const replay = await capture(rawKey, txn.id, {}, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().status, "captured");

    const afterReplay = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM ledger_entries
        WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'
          AND account_id = 'platform_fee_revenue' AND direction = 'debit'`,
      [txn.id],
    );
    assert.equal(afterReplay.rows[0]!.c, 1);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${fn} ON ledger_entries`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }
});

// FH: should also cover same key + same body on a DIFFERENT transaction -> 422 (API.md). Claude says
// that case can't happen because keys are per transaction
test("capture with a reused idempotency key but a different body is rejected as a conflict", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("idempotent-conflict");
  const txn = await authorize(rawKey, 8_000);
  const key = randomUUID();

  const first = await capture(rawKey, txn.id, { amountFils: 1_000 }, key);
  assert.equal(first.statusCode, 200, first.body);

  const conflicting = await capture(rawKey, txn.id, { amountFils: 2_000 }, key);
  assert.equal(conflicting.statusCode, 422, conflicting.body);
  assert.equal(conflicting.json().error, "idempotency_key_reused");
});

test("capture with an idempotency key reused on a different transaction is rejected as a conflict", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("idempotent-cross-txn");
  const firstTxn = await authorize(rawKey, 8_000);
  const secondTxn = await authorize(rawKey, 8_000);
  const key = randomUUID();

  const first = await capture(rawKey, firstTxn.id, {}, key);
  assert.equal(first.statusCode, 200, first.body);

  const conflicting = await capture(rawKey, secondTxn.id, {}, key);
  assert.equal(conflicting.statusCode, 422, conflicting.body);
  assert.equal(conflicting.json().error, "idempotency_key_reused");

  const result = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [secondTxn.id],
  );
  const txn = result.rows[0];
  assert.ok(txn);
  assert.equal(txn.status, "authorized");
  assert.equal(Number(txn.captured_fils), 0);
});

/** Covers GET detail/events and capture. Cross-tenant refund has its own test below. */
test("cross-tenant transaction access (wrong merchant) returns 404, not 403 or 500", async () => {
  const owner = await createApprovedMerchantWithApiKey("cross-tenant-owner");
  const intruder = await createApprovedMerchantWithApiKey("cross-tenant-intruder");
  const txn = await authorize(owner.rawKey, 5_000);

  const getRes = await app.inject({
    method: "GET",
    url: `/v1/transactions/${txn.id}`,
    headers: authHeader(intruder.rawKey),
  });
  assert.equal(getRes.statusCode, 404, getRes.body);

  const captureRes = await capture(intruder.rawKey, txn.id);
  assert.equal(captureRes.statusCode, 404, captureRes.body);
  assert.equal(captureRes.json().error, "transaction_not_found");

  const voidRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/void`,
    headers: authHeader(intruder.rawKey),
  });
  assert.equal(voidRes.statusCode, 404, voidRes.body);
});

test("capture amount exceeding remaining is rejected 422", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("capture-exceeds");
  const txn = await authorize(rawKey, 5_000);

  const res = await capture(rawKey, txn.id, { amountFils: 5_001 });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error, "capture_exceeds_remaining");
  assert.equal(res.json().remainingFils, 5_000);
});

test("capture with a malformed or non-positive amount is rejected 400 invalid_amount, not 500 or 422", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("capture-bad-amount");
  const txn = await authorize(rawKey, 5_000);

  // Wrong type, non-integer, negative, null, and zero. Each must be a clean
  // 400 invalid_amount: the first four would otherwise crash toFils into a 500,
  // and zero would slip through to a 422 capture_exceeds_remaining.
  for (const amountFils of ["abc", 1.5, -5, null, 0]) {
    const res = await capture(rawKey, txn.id, { amountFils } as { amountFils?: number });
    assert.equal(res.statusCode, 400, `${JSON.stringify(amountFils)} -> ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
  }

  // The transaction is untouched by any of the rejected attempts.
  const after = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(after.rows[0]!.status, "authorized");
  assert.equal(Number(after.rows[0]!.captured_fils), 0);
});

test("GET /v1/transactions/:id/events returns the timeline in chronological order", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("events-timeline");
  const txn = await authorize(rawKey, 6_000);
  await capture(rawKey, txn.id, { amountFils: 2_000 });
  await capture(rawKey, txn.id);

  const res = await app.inject({
    method: "GET",
    url: `/v1/transactions/${txn.id}/events`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  const events = res.json() as Array<{ eventType: string; amountFils: number | null }>;
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["authorized", "partially_captured", "captured"],
  );
  assert.equal(events[1]!.amountFils, 2_000);
  assert.equal(events[2]!.amountFils, 4_000);
});

async function refund(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    payload: body,
  });
}

async function refundCount(transactionId: string): Promise<number> {
  const result = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  return result.rows[0]!.c;
}

test("POST /v1/refunds refunds the caller's captured transaction and replays a same-key retry", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("refund-route", 250);
  const txn = await authorize(rawKey, 10_000);
  assert.equal((await capture(rawKey, txn.id)).statusCode, 200);
  const key = randomUUID();

  const first = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils: 4_000 }, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().amountFils, 4_000);
  assert.equal(first.json().feeReversedFils, 100);
  assert.equal(first.json().transactionStatus, "partially_refunded");

  const retry = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils: 4_000 }, key);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), first.json());

  assert.equal(await refundCount(txn.id), 1);
  const row = await pool.query<{ refunded_fils: string; reason: string }>(
    `SELECT t.refunded_fils, r.reason FROM transactions t JOIN refunds r ON r.transaction_id = t.id WHERE t.id = $1`,
    [txn.id],
  );
  assert.equal(Number(row.rows[0]!.refunded_fils), 4_000);
  assert.equal(row.rows[0]!.reason, "unspecified");
});

test("POST /v1/refunds rejects a zero or negative amount and writes nothing", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("refund-bad-amount");
  const txn = await authorize(rawKey, 5_000);
  assert.equal((await capture(rawKey, txn.id)).statusCode, 200);

  for (const amountFils of [0, -500, 1.5, "100"]) {
    const res = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils });
    assert.equal(res.statusCode, 422, `${String(amountFils)}: ${res.body}`);
    assert.equal(res.json().error, "refund_amount_invalid");
  }
  assert.equal(await refundCount(txn.id), 0);
});

test("POST /v1/refunds answers refusals in the same { error, message } shape as every other error", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("refund-error-shape");
  const txn = await authorize(rawKey, 4_000);
  assert.equal((await capture(rawKey, txn.id)).statusCode, 200);

  const overKey = randomUUID();
  const over = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils: 4_001 }, overKey);
  assert.equal(over.statusCode, 422, over.body);
  assert.deepEqual(over.json(), {
    error: "refund_exceeds_refundable",
    message: "amountFils is more than is still refundable",
    refundableFils: 4_000,
  });
  // The stored rejection replays through the same mapping.
  const overReplay = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils: 4_001 }, overKey);
  assert.equal(overReplay.statusCode, 422, overReplay.body);
  assert.deepEqual(overReplay.json(), over.json());

  assert.equal((await refund(authHeader(rawKey), { transactionId: txn.id })).statusCode, 200);
  const again = await refund(authHeader(rawKey), { transactionId: txn.id, amountFils: 1 });
  assert.equal(again.statusCode, 409, again.body);
  assert.deepEqual(again.json(), {
    error: "transaction_not_refundable",
    message: "transaction cannot be refunded in its current status",
    status: "refunded",
  });
});

/** A merchantId in the body must not let one merchant refund another's transaction. */
test("POST /v1/refunds on another merchant's transaction answers 404 and refunds nothing", async () => {
  const owner = await createApprovedMerchantWithApiKey("refund-owner");
  const intruder = await createApprovedMerchantWithApiKey("refund-intruder");
  const txn = await authorize(owner.rawKey, 5_000);
  assert.equal((await capture(owner.rawKey, txn.id)).statusCode, 200);

  const res = await refund(authHeader(intruder.rawKey), { transactionId: txn.id, merchantId: owner.merchantId });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error, "transaction_not_found");
  assert.equal(await refundCount(txn.id), 0);
});

test("POST /v1/refunds needs an Idempotency-Key, a transactionId and an owner or finance session", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("refund-guards");
  const txn = await authorize(rawKey, 3_000);
  assert.equal((await capture(rawKey, txn.id)).statusCode, 200);

  const noKey = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: authHeader(rawKey),
    payload: { transactionId: txn.id },
  });
  assert.equal(noKey.statusCode, 400, noKey.body);
  assert.equal(noKey.json().error, "idempotency_key_required");

  const badId = await refund(authHeader(rawKey), { transactionId: "not-a-uuid" });
  assert.equal(badId.statusCode, 400, badId.body);

  // A NUL would fail the refunds INSERT after the acquirer had already paid out.
  const nulReason = await refund(authHeader(rawKey), { transactionId: txn.id, reason: "x\u0000" });
  assert.equal(nulReason.statusCode, 400, nulReason.body);
  assert.deepEqual(nulReason.json(), {
    error: "invalid_request",
    message: "reason must not contain a NUL character",
  });
  for (const reason of ["x".repeat(501), 42]) {
    const badReason = await refund(authHeader(rawKey), { transactionId: txn.id, reason });
    assert.equal(badReason.statusCode, 400, badReason.body);
    assert.equal(badReason.json().message, "reason must be text of at most 500 characters");
  }

  const support = await refund(cookieHeader(await createSessionWithRole(merchantId, "support")), {
    transactionId: txn.id,
  });
  assert.equal(support.statusCode, 403, support.body);
  assert.equal(await refundCount(txn.id), 0);

  const finance = await refund(cookieHeader(await createSessionWithRole(merchantId, "finance")), {
    transactionId: txn.id,
    reason: "requested_by_customer",
  });
  assert.equal(finance.statusCode, 200, finance.body);
  assert.equal(finance.json().transactionStatus, "refunded");
});

test("a 'support' session cannot capture or void; 'finance' can", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("support-role");
  const supportToken = await createSessionWithRole(merchantId, "support");
  const financeToken = await createSessionWithRole(merchantId, "finance");
  const toCapture = await authorize(rawKey, 2_000);
  const toVoid = await authorize(rawKey, 2_000);

  const supportCapture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${toCapture.id}/capture`,
    headers: { ...cookieHeader(supportToken), "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(supportCapture.statusCode, 403, supportCapture.body);
  const supportVoid = await app.inject({
    method: "POST",
    url: `/v1/transactions/${toVoid.id}/void`,
    headers: cookieHeader(supportToken),
  });
  assert.equal(supportVoid.statusCode, 403, supportVoid.body);

  const statuses = await pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE id = ANY($1::uuid[])`,
    [[toCapture.id, toVoid.id]],
  );
  assert.deepEqual(statuses.rows.map((r) => r.status), ["authorized", "authorized"]);

  const financeCapture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${toCapture.id}/capture`,
    headers: { ...cookieHeader(financeToken), "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(financeCapture.statusCode, 200, financeCapture.body);
  const financeVoid = await app.inject({
    method: "POST",
    url: `/v1/transactions/${toVoid.id}/void`,
    headers: cookieHeader(financeToken),
  });
  assert.equal(financeVoid.statusCode, 200, financeVoid.body);
});

test("list rejects a garbage cursor and a non-numeric limit with 400 instead of silently serving page one (BHA-88)", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("list-bad-cursor");
  const crafted = Buffer.from("not-a-date|not-a-uuid", "utf8").toString("base64url");
  const badDate = Buffer.from(`2026-13-45 99:99:99+00|${randomUUID()}`, "utf8").toString("base64url");
  for (const query of ["cursor=garbage", "cursor=%%%", `cursor=${crafted}`, `cursor=${badDate}`, "limit=abc"]) {
    const res = await app.inject({ method: "GET", url: `/v1/transactions?${query}`, headers: authHeader(rawKey) });
    assert.equal(res.statusCode, 400, `${query}: ${res.body}`);
  }
});

test("authorize rejects a zero, negative, fractional, NaN or non-number amount with 400 before the acquirer is called (BHA-79)", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("authorize-bad-amount");
  const original = app.acquirer.authorize;
  let acquirerCalls = 0;
  app.acquirer.authorize = (req) => {
    acquirerCalls += 1;
    return original.call(app.acquirer, req);
  };
  try {
    // JSON cannot carry NaN, so it arrives as null or a string; both must be refused too.
    for (const amountFils of [0, -5, 1.5, null, "NaN", "100", Number.MAX_SAFE_INTEGER + 2]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/transactions",
        headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
        payload: { amountFils, card: VALID_CARD },
      });
      assert.equal(res.statusCode, 400, `${String(amountFils)}: ${res.body}`);
      assert.equal(res.json().error, "invalid_amount");
    }
    assert.equal(acquirerCalls, 0);
  } finally {
    app.acquirer.authorize = original;
  }
});

test("authorize rejects an empty or malformed card with 400 before the acquirer is called, never a 500 (BHA-80)", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("authorize-bad-card");
  const original = app.acquirer.authorize;
  let acquirerCalls = 0;
  app.acquirer.authorize = (req) => {
    acquirerCalls += 1;
    return original.call(app.acquirer, req);
  };
  try {
    const malformedCards = [
      {},
      { expiryMonth: 12, expiryYear: 2030, cvv: "123" }, // pan missing
      { pan: 4242424242424242, expiryMonth: 12, expiryYear: 2030, cvv: "123" }, // pan not a string
      { pan: "4242424242424242", expiryYear: 2030, cvv: "123" }, // expiryMonth missing
      { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030 }, // cvv missing
      null,
      "4242424242424242",
    ];
    for (const card of malformedCards) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/transactions",
        headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
        payload: { amountFils: 1_000, card },
      });
      assert.equal(res.statusCode, 400, `${JSON.stringify(card)}: ${res.body}`);
      assert.equal(res.json().error, "invalid_request", res.body);
      // The error response must not leak internals (stack trace, SQL, pg detail).
      assert.ok(!/\binternal_error\b|\n\s+at\s|SELECT |INSERT /.test(res.body), `leaked internals: ${res.body}`);
    }
    assert.equal(acquirerCalls, 0);
  } finally {
    app.acquirer.authorize = original;
  }
});
