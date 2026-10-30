import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sha256Hex, randomToken } from "../lib/crypto.js";
import { hashPassword } from "./passwords.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { getPublicPaymentLink } from "../paymentLinks/read.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { toFils } from "@filspay/money";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("geminiMerchantIsolation.reg.test.ts requires DATABASE_URL");
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  FEATURE_REFUNDS: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
});
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const FIXED_PASSWORD = "GeminiIsolationPassword!99";

async function createMerchantFixture(name: string, mdrBps = 250) {
  const m = await pool.query<{ id: string }>(
    "INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, $2, 'approved') RETURNING id",
    [`${name} ${randomUUID()}`, mdrBps],
  );
  const merchantId = m.rows[0]!.id;

  const passwordHash = await hashPassword(FIXED_PASSWORD, config);
  const u = await pool.query<{ id: string }>(
    "INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id",
    [merchantId, `${randomUUID()}@merchant.test`, passwordHash],
  );
  const userId = u.rows[0]!.id;

  const rawKey = randomUUID();
  const k = await pool.query<{ id: string }>(
    "INSERT INTO api_keys (merchant_id, key_hash, key_prefix, created_by) VALUES ($1, $2, 'fp_iso', $3) RETURNING id",
    [merchantId, sha256Hex(rawKey), userId],
  );
  const apiKeyId = k.rows[0]!.id;

  const sessionRaw = randomToken(32);
  const s = await pool.query<{ id: string }>(
    "INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at) VALUES ($1, $2, true, now() + interval '2 hours') RETURNING id",
    [userId, sha256Hex(sessionRaw)],
  );

  return {
    merchantId,
    userId,
    apiKeyId,
    rawKey,
    sessionRaw,
    sessionCookie: `${config.cookieName}=${sessionRaw}`,
  };
}

async function authorizeAndCapture(rawKey: string, amountFils = 10000, captureFils = 10000) {
  const authRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD, reference: "gemini-iso-test" },
  });
  assert.equal(authRes.statusCode, 201, authRes.body);
  const txnId = authRes.json().id as string;

  const capRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: captureFils },
  });
  assert.equal(capRes.statusCode, 200, capRes.body);

  return txnId;
}

// BUG-003: Cross-merchant refund prevention
test("BUG-003: cross-merchant refund is rejected via initiateMerchantRefund and API routes", async () => {
  const merchantA = await createMerchantFixture("Merchant A");
  const merchantB = await createMerchantFixture("Merchant B");

  const txnIdA = await authorizeAndCapture(merchantA.rawKey, 10000, 10000);

  // 1. Direct initiateMerchantRefund call with Merchant B attempting to refund Merchant A's transaction
  const dummyAcquirer = {
    ...app.acquirer,
    refund: async () => {
      throw new Error("Acquirer must not be contacted for cross-merchant refund");
    },
  };

  await assert.rejects(
    initiateMerchantRefund(pool, dummyAcquirer, {
      merchantId: merchantB.merchantId,
      transactionId: txnIdA,
      amountFils: toFils(5000),
      idempotencyKey: randomUUID(),
      actor: { type: "merchant_api_key", id: merchantB.apiKeyId },
      reason: "cross-tenant-attempt",
    }),
    (err: any) => {
      assert.equal(err.code || err.message, "transaction_not_found");
      return true;
    },
  );

  // 2. HTTP route POST /v1/merchants/:merchantId/refunds with mismatched path vs auth
  const resForbidden = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantA.merchantId}/refunds`,
    headers: {
      authorization: `Bearer ${merchantB.rawKey}`,
      "idempotency-key": randomUUID(),
    },
    payload: { transactionId: txnIdA, amountFils: 5000 },
  });
  assert.equal(resForbidden.statusCode, 403);

  // 3. HTTP route POST /v1/refunds (or scoped) using Merchant B credentials targeting Transaction A
  const resNotFound = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantB.merchantId}/refunds`,
    headers: {
      authorization: `Bearer ${merchantB.rawKey}`,
      "idempotency-key": randomUUID(),
    },
    payload: { transactionId: txnIdA, amountFils: 5000 },
  });
  assert.equal(resNotFound.statusCode, 404);

  // Verify that Transaction A has not been refunded
  const row = (await pool.query("SELECT refunded_fils, status FROM transactions WHERE id = $1", [txnIdA])).rows[0];
  assert.equal(Number(row.refunded_fils), 0);
  assert.equal(row.status, "captured");
});

// BUG-018: Cross-merchant payment link cancellation
test("BUG-018: cross-merchant payment link cancellation is rejected and link remains active", async () => {
  const merchantA = await createMerchantFixture("Merchant A Links");
  const merchantB = await createMerchantFixture("Merchant B Links");

  const token = `plink_${randomUUID()}`;
  const linkInsert = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 5000, now() + interval '1 hour', 'merchant_session', $3)
     RETURNING id`,
    [merchantA.merchantId, token, merchantA.userId],
  );
  const linkIdA = linkInsert.rows[0]!.id;

  // 1. Direct helper call: Merchant B attempts to cancel Merchant A's link
  const helperResult = await cancelPaymentLink(pool, {
    id: linkIdA,
    merchantId: merchantB.merchantId,
  });
  assert.equal(helperResult.outcome, "not_found");

  // 2. HTTP route DELETE /v1/merchants/:merchantId/payment-links/:id
  const httpResult = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantB.merchantId}/payment-links/${linkIdA}`,
    headers: { authorization: `Bearer ${merchantB.rawKey}` },
  });
  assert.equal(httpResult.statusCode, 404);

  // Ensure link is still active and unmodified
  const publicLink = await getPublicPaymentLink(pool, token, 1);
  assert.ok(publicLink);
  assert.equal(publicLink.status, "active");
});

// BUG-019: Split merchant reporting scope IDOR
test("BUG-019: reporting scope prevents split parent from querying other parent's child", async () => {
  const parentA = await createMerchantFixture("Parent A Split");
  const parentB = await createMerchantFixture("Parent B Split");
  const childA = await createMerchantFixture("Child A Split");
  const childB = await createMerchantFixture("Child B Split");

  // Register child relations
  await pool.query(
    "INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, weight_bps) VALUES ($1, $2, 5000)",
    [parentA.merchantId, childA.merchantId],
  );
  await pool.query(
    "INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, weight_bps) VALUES ($1, $2, 5000)",
    [parentB.merchantId, childB.merchantId],
  );

  // 1. Parent A requesting their own child Child A -> allowed, returns Child A
  const authorizedScope = await resolveReportMerchantId(pool, parentA.merchantId, childA.merchantId);
  assert.equal(authorizedScope, childA.merchantId);

  // 2. Parent A requesting Parent B's child Child B -> MUST NOT return Child B!
  // It must fallback to Parent A's own ID.
  const unauthorizedScope = await resolveReportMerchantId(pool, parentA.merchantId, childB.merchantId);
  assert.equal(
    unauthorizedScope,
    parentA.merchantId,
    "BUG-019: Parent A must not be able to query Child B belonging to Parent B",
  );
});

// BUG-004: Impersonation write protection
test("BUG-004: impersonation session cannot execute capture, void, refund or create API keys", async () => {
  const merchant = await createMerchantFixture("Merchant Impersonate");

  // Create an admin user and impersonation grant
  const adminPass = await hashPassword(FIXED_PASSWORD, config);
  const admin = (
    await pool.query<{ id: string }>(
      "INSERT INTO admin_users (email, password_hash, role, display_name) VALUES ($1, $2, 'super_admin', 'Admin Auditor') RETURNING id",
      [`${randomUUID()}@admin.test`, adminPass],
    )
  ).rows[0]!;

  const grantToken = randomToken(32);
  await pool.query(
    "INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
    [admin.id, merchant.merchantId, sha256Hex(grantToken)],
  );

  const impCookie = `${config.impersonationCookieName}=${grantToken}`;

  // 1. Authorize a transaction normally using merchant API key
  const authRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10000, card: CARD, reference: "impersonation-test" },
  });
  assert.equal(authRes.statusCode, 201);
  const txnId = authRes.json().id as string;

  // 2. Impersonated session attempts to capture -> 403 Forbidden
  const capRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { cookie: impCookie, "idempotency-key": randomUUID() },
    payload: { amountFils: 10000 },
  });
  assert.equal(capRes.statusCode, 403, "Impersonation must not allow transaction capture");

  // 3. Impersonated session attempts to void -> 403 Forbidden
  const voidRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/void`,
    headers: { cookie: impCookie, "idempotency-key": randomUUID() },
  });
  assert.equal(voidRes.statusCode, 403, "Impersonation must not allow transaction void");

  // 4. Capture the transaction with real key so we can test refund
  const realCap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10000 },
  });
  assert.equal(realCap.statusCode, 200);

  // 5. Impersonated session attempts to refund -> 403 Forbidden
  const refundRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchant.merchantId}/refunds`,
    headers: { cookie: impCookie, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId, amountFils: 5000 },
  });
  assert.equal(refundRes.statusCode, 403, "Impersonation must not allow transaction refund");

  // 6. Impersonated session attempts to create an API key -> 403 Forbidden
  const keyRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchant.merchantId}/api-keys`,
    headers: { cookie: impCookie },
    payload: { label: "HackedKey" },
  });
  assert.equal(keyRes.statusCode, 403, "Impersonation must not allow issuing API keys");
});

// BUG-017: Suspended merchant credential invalidation
test("BUG-017: suspended merchant sessions and API keys are immediately blocked from transactions", async () => {
  const merchant = await createMerchantFixture("Merchant Suspend Test");

  // Check that API key works while active
  const initialMe = await app.inject({
    url: "/v1/auth/me",
    headers: { cookie: merchant.sessionCookie },
  });
  assert.equal(initialMe.statusCode, 200);

  // Suspend the merchant
  await pool.query("UPDATE merchants SET status = 'suspended' WHERE id = $1", [merchant.merchantId]);

  // 1. Session lookup immediately rejects (401)
  const sessionMe = await app.inject({
    url: "/v1/auth/me",
    headers: { cookie: merchant.sessionCookie },
  });
  assert.equal(sessionMe.statusCode, 401, "Suspended merchant session must return 401");

  // 2. API key authorization immediately rejects (401)
  const authAttempt = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5000, card: CARD },
  });
  assert.equal(authAttempt.statusCode, 401, "Suspended merchant API key must return 401");

  // 3. Refund attempt immediately rejects (401)
  const refundAttempt = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchant.merchantId}/refunds`,
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: randomUUID(), amountFils: 1000 },
  });
  assert.equal(refundAttempt.statusCode, 401, "Suspended merchant refund attempt must return 401");
});
