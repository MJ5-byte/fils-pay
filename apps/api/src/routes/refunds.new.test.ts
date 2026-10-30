/**
 * POST /v1/merchants/:merchantId/refunds (FP-300 / FP-212), through
 * buildApp + inject against a real, migrated Postgres.
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
  throw new Error("refunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
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

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(label: string): Promise<{ merchantId: string; auth: { authorization: string } }> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Refund route ${label} ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, auth: { authorization: `Bearer ${key.rawKey}` } };
}

async function capturedTxn(auth: { authorization: string }, amountFils: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD, reference: "refund-route" },
  });
  const id = (a.json() as { id: string }).id;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}

test("a merchant refunds its own captured transaction through the API", async () => {
  const m = await merchant("ok");
  const txnId = await capturedTxn(m.auth, 10_000);

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/refunds`,
    headers: { ...m.auth, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId, amountFils: 4_000, reason: "customer return" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionStatus: string; refundedTotalFils: number };
  assert.equal(body.transactionStatus, "partially_refunded");
  assert.equal(body.refundedTotalFils, 4_000);

  const read = await app.inject({ method: "GET", url: `/v1/transactions/${txnId}`, headers: m.auth });
  assert.equal((read.json() as { refundedFils: number }).refundedFils, 4_000);
});

test("another merchant's path is refused and nothing is refunded", async () => {
  const owner = await merchant("owner");
  const other = await merchant("other");
  const txnId = await capturedTxn(owner.auth, 5_000);

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${owner.merchantId}/refunds`,
    headers: { ...other.auth, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId },
  });
  assert.equal(res.statusCode, 403, res.body);
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
});

test("an Idempotency-Key header and a valid amount are required", async () => {
  const m = await merchant("validation");
  const txnId = await capturedTxn(m.auth, 5_000);
  const url = `/v1/merchants/${m.merchantId}/refunds`;

  const noKey = await app.inject({ method: "POST", url, headers: m.auth, payload: { transactionId: txnId } });
  assert.equal(noKey.statusCode, 400, noKey.body);

  const badAmount = await app.inject({
    method: "POST",
    url,
    headers: { ...m.auth, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId, amountFils: 1.5 },
  });
  assert.equal(badAmount.statusCode, 400, badAmount.body);
});
