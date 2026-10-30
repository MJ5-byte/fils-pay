import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { loadConfig } from "../config.js";
import { recordKycReview } from "../onboarding/review.js";
import { createPaymentLink } from "./create.js";
import { expiryReferenceTime, payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "pay.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
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

test.after(async () => {
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

test("expiryReferenceTime: no value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime();
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("expiryReferenceTime: empty string -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

// FH: this one is the offline-terminal contract test. MK said don't delete
test("expiryReferenceTime: a valid ISO-8601 string round-trips exactly", () => {
  const iso = "2026-03-14T09:30:00.000Z";
  assert.equal(expiryReferenceTime(iso).toISOString(), iso);
});

test("expiryReferenceTime: an unparseable value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("not-a-timestamp");
  assert.ok(!Number.isNaN(resolved.getTime()));
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("a link payment rebates the negotiated discount as balanced ledger legs", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Discounted Link Merchant ${randomUUID()}`, 275, 1250],
  );
  const merchantId = merchantResult.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });

  const link = await createPaymentLink(pool, config, {
    merchantId,
    amountFils: 602,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const acquirer = createAcquirerSimulator(config);
  const result = await payPaymentLink(pool, acquirer, config, {
    token: link.token,
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
  });

  assert.equal(result.statusCode, 200);
  const { transactionId } = result.body as { transactionId: string };
  const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'
      ORDER BY account_id`,
    [transactionId],
  );
  assert.deepEqual(legs.rows, [
    { account_id: "merchant_payable", direction: "credit", amount_fils: "2" },
    { account_id: "platform_fee_revenue", direction: "debit", amount_fils: "2" },
  ]);
});
