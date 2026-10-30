/**
 * An authorization whose scheme hold has expired must be refused before
 * calling the acquirer or moving money in the ledger.
 *
 * Runs against a real, migrated Postgres (`DATABASE_URL`) and the real
 * simulator, with the hold expired using the database clock.
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
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("captureExpiredHold.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

test("an authorization with an expired hold is refused without moving money", async () => {
  await app.ready();
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`BHA-217 Merchant ${randomUUID()}`],
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
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerId, label: "bha-217" });
  const actor = { type: "merchant_api_key" as const, id: issued.id };
  const simulator = createAcquirerSimulator(config);
  const authorized = await authorizeTransaction(pool, simulator, config, {
    merchantId,
    amountFils: toFils(10_000),
    card: VALID_CARD,
    reference: "bha-217",
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(authorized.statusCode, 201);
  const transactionId = (authorized.body as { id: string }).id;

  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE transaction_id = $1`, [
    transactionId,
  ]);
  const ledgerBefore = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE transaction_id = $1`,
    [transactionId],
  );
  const transactionBefore = await pool.query(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  const volumeBefore = await pool.query(`SELECT * FROM merchant_daily_volume WHERE merchant_id = $1`, [merchantId]);
  let captureCalls = 0;
  const result = await captureTransaction(pool, {
    ...simulator,
    capture: (request) => {
      captureCalls += 1;
      return simulator.capture(request);
    },
  }, {
    transactionId,
    merchantId,
    amountFils: toFils(10_000),
    idempotencyKey: randomUUID(),
    actor,
  });

  assert.equal(result.statusCode, 409);
  assert.equal((result.body as { error: string }).error, "authorization_expired");
  assert.equal(captureCalls, 0);
  const ledgerAfter = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE transaction_id = $1`,
    [transactionId],
  );
  assert.equal(ledgerAfter.rows[0]?.n, ledgerBefore.rows[0]?.n);
  const transactionAfter = await pool.query(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  assert.deepEqual(transactionAfter.rows, transactionBefore.rows);
  const volumeAfter = await pool.query(`SELECT * FROM merchant_daily_volume WHERE merchant_id = $1`, [merchantId]);
  assert.deepEqual(volumeAfter.rows, volumeBefore.rows);
});
