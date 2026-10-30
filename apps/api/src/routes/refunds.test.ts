/**
 * Refund behaviour end to end against a real, migrated Postgres:
 * route wiring, tenant scoping, concurrency (FP-209), partial captures.
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
  throw new Error("refunds.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "20",
  ACQUIRER_LATENCY_MAX_MS: "30",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function captured(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD },
  });
  assert.equal(a.statusCode, 201, a.body);
  const id = (a.json() as { id: string }).id;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}

function refund(rawKey: string, payload: Record<string, unknown>, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": key },
    payload,
  });
}

test("POST /v1/refunds without an Idempotency-Key is a 400", async () => {
  const { rawKey } = await merchantWithKey("nokey");
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { transactionId: randomUUID() },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("POST /v1/refunds refunds a captured transaction and the ledger balances", async () => {
  const { rawKey } = await merchantWithKey("full");
  const id = await captured(rawKey, 10_000);
  const res = await refund(rawKey, { transactionId: id });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { amountFils: number; feeReversedFils: number; transactionStatus: string };
  assert.equal(body.amountFils, 10_000);
  assert.equal(body.feeReversedFils, 250); // 2.50% of 10.000 BD
  assert.equal(body.transactionStatus, "refunded");

  const net = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_fils ELSE -amount_fils END),0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1`,
    [id],
  );
  assert.equal(net.rows[0]!.net, "0");
  // the merchant is back to zero payable for this transaction
  const payable = await pool.query<{ p: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END),0)::text AS p
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'merchant_payable'`,
    [id],
  );
  assert.equal(payable.rows[0]!.p, "0");
});

test("two simultaneous full refunds: exactly one pays out (FP-209)", async () => {
  const { rawKey } = await merchantWithKey("race");
  const id = await captured(rawKey, 20_000);
  const [a, b] = await Promise.all([refund(rawKey, { transactionId: id }), refund(rawKey, { transactionId: id })]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 422], `${a.body} / ${b.body}`);

  const r = await pool.query<{ n: string; total: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount_fils),0)::text AS total
       FROM refunds WHERE transaction_id = $1 AND status = 'succeeded'`,
    [id],
  );
  assert.equal(r.rows[0]!.n, "1");
  assert.equal(r.rows[0]!.total, "20000");
});

test("ten simultaneous partial refunds never exceed the captured amount", async () => {
  const { rawKey } = await merchantWithKey("race10");
  const id = await captured(rawKey, 10_000);
  const results = await Promise.all(Array.from({ length: 10 }, () => refund(rawKey, { transactionId: id, amountFils: 3_000 })));
  const ok = results.filter((r) => r.statusCode === 200).length;
  assert.equal(ok, 3); // 3 x 3.000 = 9.000 fits; a 4th would exceed 10.000
  const t = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils::text FROM transactions WHERE id = $1`, [id]);
  assert.equal(t.rows[0]!.refunded_fils, "9000");
});

test("refundable is captured minus refunded, not the authorized amount", async () => {
  const { rawKey } = await merchantWithKey("partialcap");
  const id = await captured(rawKey, 10_000, 4_000); // 10.000 authorized, 4.000 captured
  const tooMuch = await refund(rawKey, { transactionId: id, amountFils: 5_000 });
  assert.equal(tooMuch.statusCode, 422, tooMuch.body);
  const all = await refund(rawKey, { transactionId: id });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal((all.json() as { amountFils: number }).amountFils, 4_000);
  assert.equal((all.json() as { transactionStatus: string }).transactionStatus, "refunded");
  const again = await refund(rawKey, { transactionId: id });
  assert.ok(again.statusCode === 409 || again.statusCode === 422, again.body);
});

test("partial refund fees across several refunds sum to exactly the fee charged", async () => {
  const { rawKey } = await merchantWithKey("fees");
  const id = await captured(rawKey, 1_003); // fee = 2.50% -> 25 fils (banker's)
  const fee = await pool.query<{ f: string }>(
    `SELECT SUM(amount_fils)::text AS f FROM ledger_entries WHERE transaction_id=$1 AND account_id='platform_fee_revenue' AND direction='credit'`,
    [id],
  );
  const charged = Number(fee.rows[0]!.f);
  for (const amt of [333, 333, 337]) {
    const res = await refund(rawKey, { transactionId: id, amountFils: amt });
    assert.equal(res.statusCode, 200, res.body);
  }
  const rev = await pool.query<{ r: string }>(
    `SELECT SUM(fee_reversed_fils)::text AS r FROM refunds WHERE transaction_id=$1 AND status='succeeded'`,
    [id],
  );
  assert.equal(Number(rev.rows[0]!.r), charged);
});

test("a merchant cannot refund another merchant's transaction", async () => {
  const owner = await merchantWithKey("owner");
  const attacker = await merchantWithKey("attacker");
  const id = await captured(owner.rawKey, 5_000);
  const res = await refund(attacker.rawKey, { transactionId: id });
  assert.equal(res.statusCode, 404, res.body);
  const t = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils::text FROM transactions WHERE id = $1`, [id]);
  assert.equal(t.rows[0]!.refunded_fils, "0");
});

test("replaying an Idempotency-Key does not refund twice", async () => {
  const { rawKey } = await merchantWithKey("idem");
  const id = await captured(rawKey, 6_000);
  const key = randomUUID();
  const first = await refund(rawKey, { transactionId: id, amountFils: 2_000 }, key);
  const second = await refund(rawKey, { transactionId: id, amountFils: 2_000 }, key);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), first.json());
  const n = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM refunds WHERE transaction_id=$1`, [id]);
  assert.equal(n.rows[0]!.n, "1");
});

test("a refund enqueues a refund.succeeded outbox event", async () => {
  const { rawKey } = await merchantWithKey("outbox");
  const id = await captured(rawKey, 3_000);
  const res = await refund(rawKey, { transactionId: id, amountFils: 1_000 });
  assert.equal(res.statusCode, 200, res.body);
  const e = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM outbox_events WHERE event_type='refund.succeeded' AND aggregate_id = $1`,
    [id],
  );
  assert.equal(e.rows[0]!.n, "1");
});
