/**
 * Route-level tests for the payment-links surface — create, public read,
 * pay, cancel, list — using `app.inject(...)` against `buildApp()` and a
 * real, migrated Postgres (no DB mocking). Requires `DATABASE_URL` (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { toFils } from "@filspay/money";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "paymentLinks.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

// Deterministic, fast, always-approved acquirer for these tests (except via
// magic PANs), and a short reservation timeout so the self-heal tests don't
// need to sleep for a full 60s.
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "60",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const DECLINE_CARD = { pan: "4000000000000002", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createApprovedMerchantWithApiKey(label: string) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Merchant ${label} ${randomUUID()}`, 250],
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
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });

  return { merchantId, ownerUserId, rawKey: issued.rawKey };
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

async function createLink(
  rawKey: string,
  merchantId: string,
  body: { amountFils?: number; reference?: string; description?: string; expiresAt?: string } = {},
) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: authHeader(rawKey),
    payload: {
      amountFils: body.amountFils ?? 4_750,
      reference: body.reference ?? "order-1042",
      description: body.description ?? "Invoice #1042",
      expiresAt: body.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as {
    id: string;
    token: string;
    url: string;
    amountFils: number;
    status: string;
    expiresAt: string;
  };
}

async function getPublicLink(token: string) {
  return app.inject({ method: "GET", url: `/v1/payment-links/${token}` });
}

async function pay(token: string, card: typeof APPROVED_CARD, idempotencyKey: string = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": idempotencyKey },
    payload: { card },
  });
}

test("create -> public read (active) -> pay (approved) -> public read (paid) -> pay again rejected 409", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("happy-path");
  const link = await createLink(rawKey, merchantId, { amountFils: 4_750 });
  assert.equal(link.status, "active");
  assert.ok(link.url.endsWith(`/pay/${link.token}`));

  const readActive = await getPublicLink(link.token);
  assert.equal(readActive.statusCode, 200, readActive.body);
  assert.equal(readActive.json().status, "active");
  assert.equal(readActive.json().amountFils, 4_750);
  assert.ok(readActive.json().merchantPublicKey?.startsWith("fp_"));

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 200, payRes.body);
  const payBody = payRes.json();
  assert.equal(payBody.status, "paid");
  assert.equal(payBody.amountFils, 4_750);
  assert.ok(payBody.transactionId);

  const readPaid = await getPublicLink(link.token);
  assert.equal(readPaid.statusCode, 200);
  assert.equal(readPaid.json().status, "paid");

  // Confirm the transaction and ledger rows are real and correctly linked.
  const txnRow = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [payBody.transactionId],
  );
  assert.equal(txnRow.rows[0]!.status, "captured");
  assert.equal(Number(txnRow.rows[0]!.captured_fils), 4_750);

  const linkRow = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE token = $1`, [
    link.token,
  ]);
  assert.equal(linkRow.rows[0]!.transaction_id, payBody.transactionId);

  const secondPay = await pay(link.token, APPROVED_CARD);
  assert.equal(secondPay.statusCode, 409, secondPay.body);
  assert.equal(secondPay.json().error, "payment_link_already_paid");
});

test("declined authorize releases the reservation (not burned); retry with an approved card succeeds", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("decline-then-retry");
  const link = await createLink(rawKey, merchantId, { amountFils: 2_000 });

  const declineRes = await pay(link.token, DECLINE_CARD);
  assert.equal(declineRes.statusCode, 402, declineRes.body);
  const declineBody = declineRes.json();
  assert.equal(declineBody.stage, "authorize");
  assert.equal(declineBody.error, "card_declined");

  // The link's reservation must have been released, not burned.
  const readAfterDecline = await getPublicLink(link.token);
  assert.equal(readAfterDecline.statusCode, 200);
  assert.equal(readAfterDecline.json().status, "active");

  const linkRow = await pool.query<{ status: string; reserved_at: Date | null }>(
    `SELECT status, reserved_at FROM payment_links WHERE token = $1`,
    [link.token],
  );
  assert.equal(linkRow.rows[0]!.status, "active");
  assert.equal(linkRow.rows[0]!.reserved_at, null);

  const retryRes = await pay(link.token, APPROVED_CARD);
  assert.equal(retryRes.statusCode, 200, retryRes.body);
  assert.equal(retryRes.json().status, "paid");

  const readAfterRetry = await getPublicLink(link.token);
  assert.equal(readAfterRetry.json().status, "paid");
});

/** Amount comes from the link row; the body has only card (+ optional submittedAt). */
test("pay charges exactly the link's own amount — the request body carries no amount field", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("own-amount");
  const link = await createLink(rawKey, merchantId, { amountFils: 9_999 });

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 200, payRes.body);
  assert.equal(payRes.json().amountFils, 9_999);

  const txnRow = await pool.query<{ amount_fils: string; captured_fils: string }>(
    `SELECT amount_fils, captured_fils FROM transactions WHERE id = $1`,
    [payRes.json().transactionId],
  );
  assert.equal(Number(txnRow.rows[0]!.amount_fils), 9_999);
  assert.equal(Number(txnRow.rows[0]!.captured_fils), 9_999);
});

test("expired link is rejected: read reports 'expired', pay is rejected 410", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("expired");
  const link = await createLink(rawKey, merchantId, {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  // Force expiry directly in the DB (creation itself requires a future date).
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE token = $1`, [link.token]);

  const readRes = await getPublicLink(link.token);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.json().status, "expired");

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 410, payRes.body);
  assert.equal(payRes.json().error, "payment_link_expired");
});

test("submittedAt is honored only with API-key auth; the public path judges expiry by the server clock (B14)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("b14-gate");
  const link = await createLink(rawKey, merchantId, {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE token = $1`, [link.token]);

  // Public path, past submittedAt: the client clock is ignored and the
  // server clock says expired — the old bypass (200 paid on an expired
  // link) must not happen.
  const publicPay = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD, submittedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(publicPay.statusCode, 410, publicPay.body);
  assert.equal(publicPay.json().error, "payment_link_expired");

  // Same link, same past submittedAt, but with a valid API key: the
  // documented offline-terminal contract is honored and the link pays.
  const terminalPay = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID(), authorization: "Bearer " + rawKey },
    payload: { card: APPROVED_CARD, submittedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(terminalPay.statusCode, 200, terminalPay.body);
  assert.equal(terminalPay.json().status, "paid");
});

test("canceled link is rejected via both read and pay", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("canceled-rejected");
  const link = await createLink(rawKey, merchantId, {});

  const cancelRes = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/payment-links/${link.id}`,
    headers: authHeader(rawKey),
  });
  assert.equal(cancelRes.statusCode, 204, cancelRes.body);

  const readRes = await getPublicLink(link.token);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.json().status, "canceled");

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 409, payRes.body);
  assert.equal(payRes.json().error, "payment_link_canceled");
});

test("cancel: happy path 204, nonexistent id -> 404, already-paid -> 409", async () => {
  const owner = await createApprovedMerchantWithApiKey("cancel-owner");

  // Happy path.
  const link1 = await createLink(owner.rawKey, owner.merchantId, {});
  const cancel1 = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${owner.merchantId}/payment-links/${link1.id}`,
    headers: authHeader(owner.rawKey),
  });
  assert.equal(cancel1.statusCode, 204, cancel1.body);

  // Nonexistent id -> 404.
  const cancelMissing = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${owner.merchantId}/payment-links/${randomUUID()}`,
    headers: authHeader(owner.rawKey),
  });
  assert.equal(cancelMissing.statusCode, 404, cancelMissing.body);
  assert.equal(cancelMissing.json().error, "payment_link_not_found");

  // Already-paid -> 409.
  const link3 = await createLink(owner.rawKey, owner.merchantId, {});
  const paidRes = await pay(link3.token, APPROVED_CARD);
  assert.equal(paidRes.statusCode, 200, paidRes.body);
  const cancelPaid = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${owner.merchantId}/payment-links/${link3.id}`,
    headers: authHeader(owner.rawKey),
  });
  assert.equal(cancelPaid.statusCode, 409, cancelPaid.body);
  assert.equal(cancelPaid.json().error, "not_cancelable");
});

test("cancel is scoped to the owning merchant: another merchant's link is 404 and stays active (B13)", async () => {
  const owner = await createApprovedMerchantWithApiKey("cancel-owner-b13");
  const attacker = await createApprovedMerchantWithApiKey("cancel-attacker-b13");
  const link = await createLink(owner.rawKey, owner.merchantId, {});

  // A different, fully approved merchant knows the link UUID and tries to
  // cancel it through their own path. assertOwnMerchant passes (the path
  // merchant is the attacker's own id), but cancelPaymentLink is now scoped
  // to merchant_id, so another merchant's link is indistinguishable from a
  // nonexistent one: 404, and the link is left untouched.
  const crossCancel = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${attacker.merchantId}/payment-links/${link.id}`,
    headers: authHeader(attacker.rawKey),
  });
  assert.equal(crossCancel.statusCode, 404, crossCancel.body);
  assert.equal(crossCancel.json().error, "payment_link_not_found");

  // The link was not canceled: still active on the public read, and the
  // real owner can still be paid through it.
  const readRes = await getPublicLink(link.token);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.json().status, "active");

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 200, payRes.body);
  assert.equal(payRes.json().status, "paid");
});

test("list returns created payment links for the owning merchant", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("list");
  await createLink(rawKey, merchantId, { reference: "list-a" });
  await createLink(rawKey, merchantId, { reference: "list-b" });

  const listRes = await app.inject({
    method: "GET",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: authHeader(rawKey),
  });
  assert.equal(listRes.statusCode, 200, listRes.body);
  const body = listRes.json() as { paymentLinks: Array<{ reference: string }>; nextCursor: string | null };
  const refs = body.paymentLinks.map((l) => l.reference).sort();
  assert.deepEqual(refs, ["list-a", "list-b"]);
});

test(
  "idempotent replay after a reservation-timeout retry: a crashed pre-finalize attempt finalizes cleanly " +
    "on retry without a second charge",
  async () => {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("timeout-replay");
    const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });
    const idempotencyKey = randomUUID();

    // Simulate: a first pay() attempt claimed the link, successfully ran
    // authorize+capture, then the process crashed before finalize — leaving
    // the link durably 'reserved' with a reserved_at old enough that the
    // reservation has since self-expired.
    const claimed = await pool.query<{
      id: string;
      merchant_id: string;
      amount_fils: string;
      reference: string | null;
    }>(
      `UPDATE payment_links
          SET status = 'reserved', reserved_at = now() - interval '2 minutes'
        WHERE token = $1
        RETURNING id, merchant_id, amount_fils, reference`,
      [link.token],
    );
    const row = claimed.rows[0]!;

    const authorizeKey = `paylink:${row.id}:${idempotencyKey}:authorize`;
    const authRes = await authorizeTransaction(pool, app.acquirer, {
      merchantId: row.merchant_id,
      amountFils: toFils(Number(row.amount_fils)),
      card: APPROVED_CARD,
      reference: row.reference ?? undefined,
      idempotencyKey: authorizeKey,
      actor: { type: "system" },
    });
    assert.equal(authRes.statusCode, 201, JSON.stringify(authRes.body));
    const txnId = (authRes.body as { id: string }).id;

    const captureKey = `paylink:${row.id}:${idempotencyKey}:capture`;
    const capRes = await captureTransaction(pool, app.acquirer, {
      transactionId: txnId,
      merchantId: row.merchant_id,
      idempotencyKey: captureKey,
      actor: { type: "system", id: row.id },
    });
    assert.equal(capRes.statusCode, 200, JSON.stringify(capRes.body));

    // The client now retries the pay() request with the SAME Idempotency-Key
    // (reserved_at is already old enough for the claim UPDATE to re-admit it).
    const retryRes = await pay(link.token, APPROVED_CARD, idempotencyKey);
    assert.equal(retryRes.statusCode, 200, retryRes.body);
    assert.equal(retryRes.json().transactionId, txnId);

    // Exactly one transaction exists for this merchant — the retry replayed
    // the prior authorize/capture via idempotency, it did not double-charge.
    const txnCount = await pool.query<{ c: string }>(`SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
      row.merchant_id,
    ]);
    assert.equal(Number(txnCount.rows[0]!.c), 1);

    const finalLink = await pool.query<{ status: string; transaction_id: string }>(
      `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
      [row.id],
    );
    assert.equal(finalLink.rows[0]!.status, "paid");
    assert.equal(finalLink.rows[0]!.transaction_id, txnId);
  },
);
