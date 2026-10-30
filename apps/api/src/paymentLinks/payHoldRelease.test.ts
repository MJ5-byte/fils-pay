import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { payPaymentLink } from "./pay.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const cardFingerprintKey = Buffer.alloc(32).toString("base64");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "payHoldRelease.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

test("a failed link capture voids the authorization and releases the hold", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Merchant hold-release ${randomUUID()}`, 250],
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

  const token = `plink_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links
        (merchant_id, token, amount_fils, reference, description, expires_at, created_by_type, created_by_id, status)
     VALUES ($1, $2, $3, NULL, NULL, now() + interval '1 day', 'merchant_session', $4, 'active')`,
    [merchantId, token, toFils(5000), ownerUserId],
  );

  const stubAcquirer: AcquirerSimulator = {
    authorize: async () => ({ outcome: "approved", acquirerReference: `acq_test_${randomUUID()}`, latencyMs: 0 }),
    capture: async () => ({ outcome: "declined", acquirerReference: "acq_test", latencyMs: 0 }),
    refund: async () => ({ outcome: "approved", acquirerReference: "acq_test", latencyMs: 0 }),
  };

  const result = await payPaymentLink(pool, stubAcquirer, { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey }, {
    token,
    card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
    idempotencyKey: randomUUID(),
  });
  assert.equal(result.statusCode, 402);

  const holds = await pool.query<{ status: string }>(
    `SELECT h.status FROM holds h JOIN transactions t ON t.id = h.transaction_id WHERE t.merchant_id = $1`,
    [merchantId],
  );
  assert.ok(holds.rows.length > 0);
  for (const hold of holds.rows) {
    assert.equal(hold.status, "released");
  }

  const transactions = await pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(transactions.rows.length, 1);
  assert.equal(transactions.rows[0]!.status, "voided");
});

test("a transient capture error (502) is not voided, so a same-key retry still pays the link", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Merchant retry-502 ${randomUUID()}`, 250],
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

  const token = `plink_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links
        (merchant_id, token, amount_fils, reference, description, expires_at, created_by_type, created_by_id, status)
     VALUES ($1, $2, $3, NULL, NULL, now() + interval '1 day', 'merchant_session', $4, 'active')`,
    [merchantId, token, toFils(5000), ownerUserId],
  );

  // First capture errors (acquirer transport fault -> 502, retryable); the
  // same-key retry then captures cleanly.
  let captureCalls = 0;
  const stubAcquirer: AcquirerSimulator = {
    authorize: async () => ({ outcome: "approved", acquirerReference: `acq_test_${randomUUID()}`, latencyMs: 0 }),
    capture: async () => {
      captureCalls += 1;
      return captureCalls === 1
        ? { outcome: "error", acquirerReference: "acq_test", latencyMs: 0 }
        : { outcome: "approved", acquirerReference: "acq_test", latencyMs: 0 };
    },
    refund: async () => ({ outcome: "approved", acquirerReference: "acq_test", latencyMs: 0 }),
  };

  // A capture 502 keeps the reservation, so the retry must find it stale to
  // reclaim it. Backdating reserved_at would change the reservation key.
  const config = { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey };
  const card = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
  const idempotencyKey = randomUUID();

  const first = await payPaymentLink(pool, stubAcquirer, config, { token, card, idempotencyKey });
  assert.equal(first.statusCode, 502);

  // The transient failure must leave the authorization intact (not voided),
  // otherwise the retry below can only get a 409 not_capturable.
  const afterFirst = await pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(afterFirst.rows.length, 1);
  assert.equal(afterFirst.rows[0]!.status, "authorized");

  const retry = await payPaymentLink(pool, stubAcquirer, config, { token, card, idempotencyKey });
  assert.equal(retry.statusCode, 200);

  const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE token = $1`, [token]);
  assert.equal(link.rows[0]!.status, "paid");

  const transactions = await pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(transactions.rows.length, 1);
  assert.equal(transactions.rows[0]!.status, "captured");
});
