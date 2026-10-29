import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { payPaymentLink, expiryReferenceTime } from "./pay.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

// The B15 race test below drives payPaymentLink against a real, migrated
// Postgres (no DB mocking), like paymentLinks.test.ts.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "pay.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}
const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function fastAcquirer(): AcquirerSimulator {
  return {
    authorize: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
    capture: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
    refund: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
  };
}

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

// B15: the claim's payment_links row lock is held across authorize+capture+
// finalize, so a second buyer whose claim runs while the first capture is
// still in flight can never be paid. Their claim blocks on the row lock,
// then sees the winning transaction ('paid') and gets 409 — never 200 — and
// the link produces exactly one charged transaction.
//
// Deterministic by construction: buyer 1 parks inside the acquirer capture
// call (holding the row lock) until the test releases it.
test("a second buyer on a re-claimed link cannot be paid while the first capture is in flight (B15)", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status)
     VALUES ($1, 250, 'approved') RETURNING id`,
    [`B15 merchant ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const token = `b15_${randomUUID()}`;
  const linkResult = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', '00000000-0000-0000-0000-000000000001')
     RETURNING id`,
    [merchantId, token],
  );
  const linkId = linkResult.rows[0]!.id;

  let releaseCapture!: () => void;
  let markCaptureStarted!: () => void;
  const captureStarted = new Promise<void>((resolve) => {
    markCaptureStarted = resolve;
  });
  const captureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const slowAcquirer: AcquirerSimulator = {
    ...fastAcquirer(),
    capture: async () => {
      markCaptureStarted();
      await captureGate;
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
  };
  const config = { paymentLinkReservationTimeoutSeconds: 60 };

  // Buyer 1 claims the link and parks in capture, holding the row lock.
  const buyer1 = payPaymentLink(pool, slowAcquirer, config, {
    token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  await captureStarted;

  // Buyer 2 (a fresh Idempotency-Key — the second-buyer case) starts while
  // buyer 1 is in flight: its claim blocks on the row lock.
  const buyer2 = payPaymentLink(pool, fastAcquirer(), config, {
    token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });

  // Let buyer 1 finish: capture -> finalize -> commit (link paid).
  releaseCapture();
  const res1 = await buyer1;
  assert.equal(res1.statusCode, 200, JSON.stringify(res1.body));
  assert.equal((res1.body as { status: string }).status, "paid");

  // Buyer 2's claim now proceeds against the committed row: status 'paid'
  // means no claim, no authorize, no capture — a 409, never a 200.
  const res2 = await buyer2;
  assert.equal(res2.statusCode, 409, JSON.stringify(res2.body));
  assert.equal((res2.body as { error: string }).error, "payment_link_already_paid");

  // Exactly one transaction was ever charged for this link.
  const txnCount = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1 AND status = 'captured'`,
    [merchantId],
  );
  assert.equal(Number(txnCount.rows[0]!.c), 1);

  const linkRow = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  assert.equal(linkRow.rows[0]!.status, "paid");
  assert.equal(linkRow.rows[0]!.transaction_id, (res1.body as { transactionId: string }).transactionId);
});
