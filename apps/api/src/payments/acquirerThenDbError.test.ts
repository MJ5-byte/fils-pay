/**
 * A database failure after the acquirer has approved a refund or capture
 * rolls back the idempotency claim with everything else. A retry with the
 * same client key must reach the acquirer under the same acquirer key, so it
 * replays the first answer instead of moving money a second time.
 *
 * Runs against a real, migrated Postgres (`DATABASE_URL`) and the real
 * simulator. The failure is a temporary trigger that rejects ledger inserts
 * for the one transaction under test, so no production code is touched.
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
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";
import { captureTransaction } from "./capture.js";
import { authorizeTransaction } from "./authorize.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("acquirerThenDbError.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

/** The real simulator, recording every acquirer key it is called with. Each
 *  distinct key is one movement of money; a repeated key is a cached replay. */
function countingSimulator(): {
  acquirer: AcquirerSimulator;
  authorizeKeys: string[];
  refundKeys: string[];
  captureKeys: string[];
} {
  const real = createAcquirerSimulator(config);
  const refundKeys: string[] = [];
  const captureKeys: string[] = [];
  const authorizeKeys: string[] = [];
  return {
    authorizeKeys,
    refundKeys,
    captureKeys,
    acquirer: {
      authorize: (req) => {
        authorizeKeys.push(req.idempotencyKey);
        return real.authorize(req);
      },
      capture: (req) => {
        captureKeys.push(req.idempotencyKey);
        return real.capture(req);
      },
      refund: (req) => {
        refundKeys.push(req.idempotencyKey);
        return real.refund(req);
      },
    },
  };
}

async function failLedgerInsertsFor(transactionId: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replace(/-/g, "");
  const fn = `bha170_fail_${suffix}`;
  await pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.transaction_id = '${transactionId}' THEN
         RAISE EXCEPTION 'injected ledger failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  return async () => {
    await pool.query(`DROP TRIGGER ${fn} ON ledger_entries`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  };
}

async function merchantWithAuthorizedTransaction(capture: boolean) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`BHA-170 Merchant ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]?.id;
  assert.ok(merchantId);
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerId = userResult.rows[0]?.id;
  assert.ok(ownerId);
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerId, label: "bha-170" });
  const headers = { authorization: `Bearer ${issued.rawKey}` };

  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: VALID_CARD, reference: "bha-170" },
  });
  assert.equal(authorizeRes.statusCode, 201, authorizeRes.body);
  const transactionId = (authorizeRes.json() as { id: string }).id;

  if (capture) {
    const captureRes = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/capture`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(captureRes.statusCode, 200, captureRes.body);
  }

  const apiKey = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  const apiKeyId = apiKey.rows[0]?.id;
  assert.ok(apiKeyId);
  return { merchantId, transactionId, actor: { type: "merchant_api_key" as const, id: apiKeyId } };
}

async function ledgerGroups(transactionId: string, description: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT entry_group_id)::text AS n FROM ledger_entries WHERE transaction_id = $1 AND description = $2`,
    [transactionId, description],
  );
  return Number(result.rows[0]?.n);
}

test("a refund retried after a DB failure that followed acquirer approval refunds once", async () => {
  const { merchantId, transactionId, actor } = await merchantWithAuthorizedTransaction(true);
  const sim = countingSimulator();
  const input = { transactionId, merchantId, amountFils: toFils(4_000), idempotencyKey: randomUUID(), actor };

  const restore = await failLedgerInsertsFor(transactionId);
  try {
    await assert.rejects(processRefund(pool, sim.acquirer, input), /injected ledger failure/);
  } finally {
    await restore();
  }

  const retry = await processRefund(pool, sim.acquirer, input);
  assert.equal(retry.statusCode, 200);
  assert.equal(new Set(sim.refundKeys).size, 1, `acquirer refunded under keys ${sim.refundKeys.join(", ")}`);
  assert.equal(await ledgerGroups(transactionId, "refund: gross"), 1);
});

test("a capture retried after a DB failure that followed acquirer approval captures once", async () => {
  const { merchantId, transactionId, actor } = await merchantWithAuthorizedTransaction(false);
  const sim = countingSimulator();
  const input = { transactionId, merchantId, idempotencyKey: randomUUID(), actor };

  const restore = await failLedgerInsertsFor(transactionId);
  try {
    await assert.rejects(captureTransaction(pool, sim.acquirer, input), /injected ledger failure/);
  } finally {
    await restore();
  }

  const retry = await captureTransaction(pool, sim.acquirer, input);
  assert.equal(retry.statusCode, 200);
  assert.equal(new Set(sim.captureKeys).size, 1, `acquirer captured under keys ${sim.captureKeys.join(", ")}`);
  assert.equal(await ledgerGroups(transactionId, "capture: gross"), 1);
});

test("an authorize retried after a DB failure that followed acquirer approval holds once", async () => {
  const { merchantId, actor } = await merchantWithAuthorizedTransaction(false);
  const sim = countingSimulator();
  const input = {
    merchantId,
    amountFils: toFils(5_000),
    card: VALID_CARD,
    reference: "bha-181",
    idempotencyKey: randomUUID(),
    actor,
  };

  const suffix = randomUUID().replace(/-/g, "");
  const fn = `bha181_fail_${suffix}`;
  await pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.reference = 'bha-181' THEN
         RAISE EXCEPTION 'injected transaction failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(authorizeTransaction(pool, sim.acquirer, input), /injected transaction failure/);
  } finally {
    await pool.query(`DROP TRIGGER ${fn} ON transactions`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }

  const retry = await authorizeTransaction(pool, sim.acquirer, input);
  assert.equal(retry.statusCode, 201);
  assert.equal(new Set(sim.authorizeKeys).size, 1, `acquirer authorized under keys ${sim.authorizeKeys.join(", ")}`);
});

test("a different request under the same key after an approve-then-rollback never replays the first approval", async () => {
  const { merchantId, actor } = await merchantWithAuthorizedTransaction(false);
  const sim = countingSimulator();
  const idempotencyKey = randomUUID();
  const first = { merchantId, amountFils: toFils(5_000), card: VALID_CARD, reference: "bha-181-b", idempotencyKey, actor };

  const suffix = randomUUID().replace(/-/g, "");
  const fn = `bha181b_fail_${suffix}`;
  await pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.reference = 'bha-181-b' THEN
         RAISE EXCEPTION 'injected transaction failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(authorizeTransaction(pool, sim.acquirer, first), /injected transaction failure/);
  } finally {
    await pool.query(`DROP TRIGGER ${fn} ON transactions`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }

  const second = await authorizeTransaction(pool, sim.acquirer, { ...first, amountFils: toFils(7_000) });
  assert.equal(second.statusCode, 201);
  assert.equal(new Set(sim.authorizeKeys).size, 2, `acquirer authorized under keys ${sim.authorizeKeys.join(", ")}`);
});
