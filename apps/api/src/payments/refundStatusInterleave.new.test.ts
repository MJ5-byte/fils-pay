/**
 * R4-8: transaction status when captures and refunds interleave.
 *
 * - A capture after a partial refund recomputed the status from the captured
 *   amount alone, so it reported `captured` although money had gone back.
 * - A refund racing a capture (the capture lands during the refund's
 *   acquirer call) computed the status and event type from the captured
 *   amount it read before that call, overwriting the capture's status and
 *   logging a full refund for a partial one.
 *
 * Real migrated Postgres; requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundStatusInterleave.new.test.ts requires DATABASE_URL (a migrated Postgres)");
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

async function merchantWithKey(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Interleave ${label} ${randomUUID()}`],
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
  return {
    merchantId,
    rawKey: issued.rawKey,
    actor: { type: "merchant_api_key" as const, id: key.rows[0]!.id },
  };
}

async function authorize(rawKey: string, amountFils: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "interleave" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

async function capture(rawKey: string, transactionId: string, amountFils: number) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status: string; capturedFils: number };
}

/** An approving acquirer whose refund call first runs `during` — a capture
 *  that lands while the refund is waiting on the acquirer. */
function acquirerWith(during: () => Promise<void>): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("not used");
    },
    capture() {
      throw new Error("not used");
    },
    async refund(req): Promise<AcquirerRefundResult> {
      await during();
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
}
const plainAcquirer = acquirerWith(async () => {});

async function txnRow(id: string) {
  const row = await pool.query<{ status: string; captured_fils: string; refunded_fils: string }>(
    `SELECT status, captured_fils, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  return row.rows[0]!;
}

test("a capture after a partial refund reports partially_refunded, not captured", async () => {
  const m = await merchantWithKey("capture-after-refund");
  const txn = await authorize(m.rawKey, 10_000);
  await capture(m.rawKey, txn, 4_000);

  const refund = await processRefund(pool, plainAcquirer, {
    transactionId: txn,
    merchantId: m.merchantId,
    amountFils: 1_000 as never,
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(refund.statusCode, 200, JSON.stringify(refund.body));

  const captured = await capture(m.rawKey, txn, 6_000);
  assert.equal(captured.capturedFils, 10_000);
  assert.equal(captured.status, "partially_refunded");
  assert.equal((await txnRow(txn)).status, "partially_refunded");
});

test("a refund racing a capture keeps the capture's amount in the status and logs a partial refund", async () => {
  const m = await merchantWithKey("refund-races-capture");
  const txn = await authorize(m.rawKey, 10_000);
  await capture(m.rawKey, txn, 4_000);

  // Refund the 4,000 captured so far; the remaining 6,000 is captured while
  // the refund waits on the acquirer.
  const racing = acquirerWith(async () => {
    await capture(m.rawKey, txn, 6_000);
  });
  const refund = await processRefund(pool, racing, {
    transactionId: txn,
    merchantId: m.merchantId,
    amountFils: 4_000 as never,
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(refund.statusCode, 200, JSON.stringify(refund.body));

  const row = await txnRow(txn);
  assert.equal(Number(row.captured_fils), 10_000);
  assert.equal(Number(row.refunded_fils), 4_000);
  assert.equal(row.status, "partially_refunded");
  assert.equal((refund.body as { transactionStatus: string }).transactionStatus, "partially_refunded");

  const events = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM transaction_events
      WHERE transaction_id = $1 AND event_type IN ('refunded', 'refund_partial')`,
    [txn],
  );
  assert.deepEqual(
    events.rows.map((r) => r.event_type),
    ["refund_partial"],
  );
});
