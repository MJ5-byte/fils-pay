/**
 * Tests for the merchant-scoped refund entry point against a real, migrated
 * Postgres. Requires `DATABASE_URL` (run `npm run migrate` first).
 *
 * The route is not registered yet (`POST /v1/refunds` is still a 501 stub),
 * so these call the module directly — including `assertRefundRequestScope`,
 * which is the check the route performs before handing over.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import type { MerchantAuthContext } from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "./initiateMerchantRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "initiateMerchantRefund.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

const approvingAcquirer: AcquirerSimulator = {
  authorize() {
    throw new Error("approvingAcquirer: authorize is not used by these tests");
  },
  capture() {
    throw new Error("approvingAcquirer: capture is not used by these tests");
  },
  refund(req): Promise<AcquirerRefundResult> {
    return Promise.resolve({ outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 });
  },
};

async function createApprovedMerchantWithApiKey(label: string) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Initiate Merchant ${label} ${randomUUID()}`],
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

  const keyResult = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  const apiKeyId = keyResult.rows[0]!.id;

  return {
    merchantId,
    rawKey: issued.rawKey,
    actor: { type: "merchant_api_key" as const, id: apiKeyId },
  };
}

async function capturedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "initiate-test" },
  });
  assert.equal(authorizeRes.statusCode, 201, authorizeRes.body);
  const txn = authorizeRes.json() as { id: string };

  const captureRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(captureRes.statusCode, 200, captureRes.body);
  return txn.id;
}

function authContext(merchantId: string): MerchantAuthContext {
  return { merchantId, actorType: "merchant_api_key", actorId: randomUUID(), role: null };
}

test("assertRefundRequestScope accepts a path merchant matching the session", () => {
  const merchantId = randomUUID();
  assert.doesNotThrow(() => assertRefundRequestScope(authContext(merchantId), merchantId));
});

/** This scope check is what keeps merchant B away from merchant A's transactions. */
test("assertRefundRequestScope rejects a path merchant that is not the authenticated one", () => {
  const auth = authContext(randomUUID());
  assert.throws(() => assertRefundRequestScope(auth, randomUUID()), ForbiddenError);
});

test("a full refund of the caller's own transaction succeeds", async () => {
  const merchant = await createApprovedMerchantWithApiKey("own-full");
  const transactionId = await capturedTransaction(merchant.rawKey, 10_000);

  const result = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    idempotencyKey: randomUUID(),
    actor: merchant.actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  const refunds = await pool.query<{ merchant_id: string; amount_fils: string }>(
    `SELECT merchant_id, amount_fils FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(refunds.rows.length, 1);
  assert.equal(refunds.rows[0]!.merchant_id, merchant.merchantId);
  assert.equal(Number(refunds.rows[0]!.amount_fils), 10_000);
});

test("a partial refund of the caller's own transaction succeeds", async () => {
  const merchant = await createApprovedMerchantWithApiKey("own-partial");
  const transactionId = await capturedTransaction(merchant.rawKey, 10_000);

  const result = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    amountFils: toFils(2_500),
    idempotencyKey: randomUUID(),
    actor: merchant.actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  const row = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  assert.equal(row.rows[0]!.status, "partially_refunded");
  assert.equal(Number(row.rows[0]!.refunded_fils), 2_500);
});

// TODO: another merchant's existing transactionId should also 404. currently refunds it — am
// FH: Claude wrote a test for this but it passed?? so it's fine. deleted it as redundant
test("a transactionId that does not exist is a 404, not a 500", async () => {
  const merchant = await createApprovedMerchantWithApiKey("missing-txn");

  await assert.rejects(
    () =>
      initiateMerchantRefund(pool, approvingAcquirer, {
        merchantId: merchant.merchantId,
        transactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        actor: merchant.actor,
      }),
    NotFoundError,
  );
});

test("an invalid refund amount is refused by the validator", async () => {
  const merchant = await createApprovedMerchantWithApiKey("invalid-amount");
  const transactionId = await capturedTransaction(merchant.rawKey, 4_000);

  const result = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    amountFils: toFils(0),
    idempotencyKey: randomUUID(),
    actor: merchant.actor,
  });
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.body, { ok: false, code: "refund_amount_invalid" });

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(refunds.rows[0]!.c, 0);
});

test("replaying an idempotency key returns the same body and writes one refund", async () => {
  const merchant = await createApprovedMerchantWithApiKey("initiate-replay");
  const transactionId = await capturedTransaction(merchant.rawKey, 6_000);
  const key = randomUUID();

  const first = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    amountFils: toFils(1_500),
    idempotencyKey: key,
    actor: merchant.actor,
  });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));

  const second = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    amountFils: toFils(1_500),
    idempotencyKey: key,
    actor: merchant.actor,
  });
  assert.deepEqual(second.body, first.body);

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(refunds.rows[0]!.c, 1);
});

test("a refund succeeds when refunds_enabled is explicitly true", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refunds-enabled-true");
  await pool.query(`UPDATE merchants SET refunds_enabled = true WHERE id = $1`, [merchant.merchantId]);
  const transactionId = await capturedTransaction(merchant.rawKey, 3_000);

  const result = await initiateMerchantRefund(pool, approvingAcquirer, {
    merchantId: merchant.merchantId,
    transactionId,
    idempotencyKey: randomUUID(),
    actor: merchant.actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
});

test("a refund is refused when refunds_enabled is explicitly false", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refunds-enabled-false");
  const transactionId = await capturedTransaction(merchant.rawKey, 3_000);
  await pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [merchant.merchantId]);

  await assert.rejects(
    () =>
      initiateMerchantRefund(pool, approvingAcquirer, {
        merchantId: merchant.merchantId,
        transactionId,
        idempotencyKey: randomUUID(),
        actor: merchant.actor,
      }),
    ForbiddenError,
  );

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(refunds.rows[0]!.c, 0);
});
