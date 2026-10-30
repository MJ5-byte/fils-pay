/**
 * Refund money bugs fixed for FP-300 / FP-212, against a real, migrated
 * Postgres. Transactions are set up through the real authorize/capture
 * routes, as in processRefund.test.ts.
 *
 * #46 refund capped at captured, not authorized
 * #51 a merchant can't refund another merchant's transaction
 * #50 two concurrent refunds can't both pay out
 * #5  partial refunds never reverse more fee in total than was charged
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
import type { AcquirerOutcome, AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("processRefund.fixes.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function fixedAcquirer(outcome: AcquirerOutcome, delayMs = 0): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("fixedAcquirer: authorize is not used by these tests");
    },
    capture() {
      throw new Error("fixedAcquirer: capture is not used by these tests");
    },
    async refund(req): Promise<AcquirerRefundResult> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { outcome, acquirerReference: req.acquirerReference, latencyMs: delayMs };
    },
  };
}

async function merchantWithKey(label: string): Promise<{ merchantId: string; rawKey: string; actorId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund fixes ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  const key = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  return { merchantId, rawKey: issued.rawKey, actorId: key.rows[0]!.id };
}

async function captured(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-fixes" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(
  m: { merchantId: string; actorId: string },
  transactionId: string,
  amountFils: number,
  acquirer = fixedAcquirer("approved"),
) {
  return processRefund(pool, acquirer, {
    transactionId,
    merchantId: m.merchantId,
    amountFils: toFils(amountFils),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: m.actorId },
  });
}

async function refundedFils(transactionId: string): Promise<number> {
  const r = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [
    transactionId,
  ]);
  return Number(r.rows[0]!.refunded_fils);
}

test("#46: a partially captured transaction can't refund more than was captured", async () => {
  const m = await merchantWithKey("cap");
  const txnId = await captured(m.rawKey, 10_000, 4_000);

  const tooMuch = await refund(m, txnId, 10_000);
  assert.equal(tooMuch.statusCode, 422, JSON.stringify(tooMuch.body));
  assert.equal((tooMuch.body as { code: string }).code, "refund_exceeds_refundable");

  const ok = await refund(m, txnId, 4_000);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(await refundedFils(txnId), 4_000);
});

test("#51: another merchant can't refund a transaction that isn't theirs", async () => {
  const owner = await merchantWithKey("owner");
  const other = await merchantWithKey("other");
  const txnId = await captured(owner.rawKey, 5_000);

  const res = await refund(other, txnId, 5_000);
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  assert.equal(await refundedFils(txnId), 0);
});

test("#50: two concurrent refunds that together exceed the capture can't both succeed", async () => {
  const m = await merchantWithKey("race");
  const txnId = await captured(m.rawKey, 10_000);
  const slow = fixedAcquirer("approved", 200);

  const results = await Promise.all([refund(m, txnId, 6_000, slow), refund(m, txnId, 6_000, slow)]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 422], JSON.stringify(results.map((r) => r.body)));
  assert.equal(await refundedFils(txnId), 6_000);

  const refunds = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM refunds WHERE transaction_id = $1 AND status = 'succeeded'`,
    [txnId],
  );
  assert.equal(Number(refunds.rows[0]!.n), 1);
});

test("#50: a declined refund releases its reservation", async () => {
  const m = await merchantWithKey("decline");
  const txnId = await captured(m.rawKey, 10_000);

  const declined = await refund(m, txnId, 10_000, fixedAcquirer("declined"));
  assert.equal(declined.statusCode, 402);
  assert.equal(await refundedFils(txnId), 0);

  const retry = await refund(m, txnId, 10_000);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
});

test("#5: partial refunds reverse exactly the fee charged, never more", async () => {
  const m = await merchantWithKey("fee");
  // 120 fils at 250 bps = 3 fils fee. Rounding each half on its own
  // (1.5 → 2, twice) used to reverse 4.
  const txnId = await captured(m.rawKey, 120);

  const first = await refund(m, txnId, 60);
  const second = await refund(m, txnId, 60);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));

  const fees = await pool.query<{ charged: string; reversed: string }>(
    `SELECT
       COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'credit' AND description NOT LIKE 'refund:%'), 0) AS charged,
       COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'debit' AND description LIKE 'refund:%'), 0) AS reversed
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [txnId],
  );
  assert.equal(Number(fees.rows[0]!.charged), 3);
  assert.equal(Number(fees.rows[0]!.reversed), 3);
});
