/**
 * BHA-123: a refund carries a unique reference, so a retried or re-posted
 * refund that resolves to the same acquirer refund reference is recorded
 * once and never moves the money twice.
 *
 * Needs DATABASE_URL on a real, migrated Postgres (run `npm run migrate`
 * first), like the other refund tests.
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
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "refundUniqueReference.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

/** An acquirer that always returns the same refund reference, as a replayed
 *  or re-imported refund of one acquirer transaction would. */
function fixedReferenceAcquirer(acquirerReference: string): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("fixedReferenceAcquirer: authorize is not used by this test");
    },
    capture() {
      throw new Error("fixedReferenceAcquirer: capture is not used by this test");
    },
    refund(): Promise<AcquirerRefundResult> {
      return Promise.resolve({ outcome: "approved", acquirerReference, latencyMs: 0 });
    },
  };
}

async function capturedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "unique-ref-test" },
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

test("a second refund with the same acquirer reference posts once and returns the first refund", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Unique Ref Merchant ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = userResult.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "unique-ref" });

  const transactionId = await capturedTransaction(issued.rawKey, 10_000);
  const apiKeyRow = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  const actor = { type: "merchant_api_key" as const, id: apiKeyRow.rows[0]!.id };

  // One acquirer refund reference, two distinct idempotency keys: a client
  // retry with no idempotency anchor, or a re-import of the same refund.
  const acquirer = fixedReferenceAcquirer(`acqr_${randomUUID()}`);

  const first = await processRefund(pool, acquirer, {
    transactionId,
    merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));

  const second = await processRefund(pool, acquirer, {
    transactionId,
    merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));

  // The second attempt returns the refund recorded first, unchanged.
  assert.deepEqual(second.body, first.body);

  // Exactly one refund row, and the money moved exactly once.
  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(refunds.rows[0]!.c, 1);

  const txn = await pool.query<{ refunded_fils: string }>(
    `SELECT refunded_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  assert.equal(Number(txn.rows[0]!.refunded_fils), 3_000);
});
