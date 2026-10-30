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
import { payPaymentLink } from "../paymentLinks/pay.js";
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
const APPROVED_CARD_B = { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "999" };
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

test("public read exposes no part of the merchant's API key", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("no-key-leak");
  const link = await createLink(rawKey, merchantId, { amountFils: 4_750 });

  const keys = await pool.query<{ key_hash: string; key_prefix: string }>(
    `SELECT key_hash, key_prefix FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL`,
    [merchantId],
  );
  assert.ok(keys.rows.length > 0);

  const res = await getPublicLink(link.token);
  assert.equal(res.statusCode, 200, res.body);
  for (const key of keys.rows) {
    assert.ok(!res.body.includes(key.key_hash), "public response exposes an API key hash");
    assert.ok(!res.body.includes(key.key_prefix), "public response exposes an API key prefix");
  }
  assert.equal("merchantIntegrationId" in res.json(), false);
  assert.equal("merchantPublicKey" in res.json(), false);
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

test("an invalid card answers 400 without reserving the link; a real buyer right after pays it", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("invalid-card-no-reserve");
  const link = await createLink(rawKey, merchantId, { amountFils: 2_000 });

  const badRes = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: {} },
  });
  assert.equal(badRes.statusCode, 400, badRes.body);

  const linkRow = await pool.query<{ status: string; reserved_at: Date | null }>(
    `SELECT status, reserved_at FROM payment_links WHERE token = $1`,
    [link.token],
  );
  assert.equal(linkRow.rows[0]?.status, "active");
  assert.equal(linkRow.rows[0]?.reserved_at, null);

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 200, payRes.body);
  assert.equal(payRes.json().status, "paid");
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

// Expired links are rejected with or without a buyer submittedAt (BHA-7).
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

test("expired link holding a stale reservation pays as expired, not processing (BHA-60)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("expired-stale-reservation");
  const link = await createLink(rawKey, merchantId, {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  // The link expired while still 'reserved' by an attempt that never cleaned
  // up its hold: reserved_at is old enough that the reservation has
  // self-expired, and expires_at is in the past.
  await pool.query(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
      WHERE token = $1`,
    [link.token],
  );

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 410, payRes.body);
  assert.equal(payRes.json().error, "payment_link_expired");
});

test("expired link stays unpaid when the buyer sends an old submittedAt (BHA-7)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("expired-old-submitted-at");
  const link = await createLink(rawKey, merchantId, {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  // Force expiry directly in the DB (creation itself requires a future date).
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE token = $1`, [link.token]);

  const payRes = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD, submittedAt: new Date(Date.now() - 3_600_000).toISOString() },
  });
  assert.equal(payRes.statusCode, 410, payRes.body);
  assert.equal(payRes.json().error, "payment_link_expired");

  const linkRow = await pool.query<{ status: string; paid_at: Date | null }>(
    `SELECT status, paid_at FROM payment_links WHERE token = $1`,
    [link.token],
  );
  const row = linkRow.rows[0];
  assert.ok(row);
  assert.notEqual(row.status, "paid");
  assert.equal(row.paid_at, null);
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

// no cross-merchant cancel case here. covered in webhooks.test.ts style elsewhere? — am
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

test("cancel: another merchant's link answers 404 and the link stays active", async () => {
  const alpha = await createApprovedMerchantWithApiKey("cancel-alpha");
  const beta = await createApprovedMerchantWithApiKey("cancel-beta");
  const link = await createLink(alpha.rawKey, alpha.merchantId, {});

  const cancelOther = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${beta.merchantId}/payment-links/${link.id}`,
    headers: authHeader(beta.rawKey),
  });
  assert.equal(cancelOther.statusCode, 404, cancelOther.body);
  assert.equal(cancelOther.json().error, "payment_link_not_found");

  const linkRow = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1`,
    [link.id],
  );
  assert.equal(linkRow.rows[0]?.status, "active");

  const cancelOwn = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${alpha.merchantId}/payment-links/${link.id}`,
    headers: authHeader(alpha.rawKey),
  });
  assert.equal(cancelOwn.statusCode, 204, cancelOwn.body);
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
      reservation_id: string;
    }>(
      `UPDATE payment_links
          SET status = 'reserved', reserved_at = now() - interval '2 minutes'
        WHERE token = $1
        RETURNING id, merchant_id, amount_fils, reference,
          to_char(reserved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reservation_id`,
      [link.token],
    );
    const row = claimed.rows[0]!;

    const authorizeKey = `paylink:${row.id}:${row.reservation_id}:authorize`;
    const authRes = await authorizeTransaction(pool, app.acquirer, config, {
      merchantId: row.merchant_id,
      amountFils: toFils(Number(row.amount_fils)),
      card: APPROVED_CARD,
      reference: row.reference ?? undefined,
      idempotencyKey: authorizeKey,
      actor: { type: "system" },
    });
    assert.equal(authRes.statusCode, 201, JSON.stringify(authRes.body));
    const txnId = (authRes.body as { id: string }).id;

    const captureKey = `paylink:${row.id}:${row.reservation_id}:capture`;
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

test("a stale reservation reclaimed by a second pay is captured once: both requests answer the one transaction the link records", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("stale-concurrent-pay");
  const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });
  let captureCalls = 0;
  let signalCaptureEntered: () => void = () => assert.fail("captureEntered is not initialized");
  const captureEntered = new Promise<void>((resolve) => {
    signalCaptureEntered = resolve;
  });
  let releaseCapture: () => void = () => assert.fail("captureGate is not initialized");
  const captureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  const acquirer: Parameters<typeof payPaymentLink>[1] = {
    ...app.acquirer,
    capture: async (req) => {
      captureCalls += 1;
      signalCaptureEntered();
      await captureGate;
      return app.acquirer.capture(req);
    },
  };

  const pA = payPaymentLink(pool, acquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
    token: link.token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  await captureEntered;

  let signalBClaimed: () => void = () => assert.fail("bClaimed is not initialized");
  const bClaimed = new Promise<void>((resolve) => {
    signalBClaimed = resolve;
  });
  const bPool = new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return async (...args: [text: string, values?: unknown[]]) => {
          const result = await pool.query(...args);
          if (args[0].includes("SET status = 'reserved'")) {
            signalBClaimed();
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pB = payPaymentLink(bPool, acquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
    token: link.token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  await bClaimed;
  releaseCapture();

  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(captureCalls, 1);
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));
  assert.ok(a.body && typeof a.body === "object" && "transactionId" in a.body, JSON.stringify(a.body));
  assert.ok(b.body && typeof b.body === "object" && "transactionId" in b.body, JSON.stringify(b.body));
  assert.equal(a.body.transactionId, b.body.transactionId);

  const txnCount = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(txnCount.rows[0]?.c, 1);
  const finalLink = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.id],
  );
  assert.equal(finalLink.rows[0]?.status, "paid");
  assert.equal(finalLink.rows[0]?.transaction_id, a.body.transactionId);
});

test("a different-card reclaim is rejected 409 processing and only the first card is charged", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("different-card-reclaim");
  const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });
  const claimed = await pool.query<{
    id: string;
    merchant_id: string;
    amount_fils: string;
    reference: string | null;
    reservation_id: string;
  }>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now() - interval '2 minutes'
      WHERE token = $1
      RETURNING id, merchant_id, amount_fils, reference,
        to_char(reserved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reservation_id`,
    [link.token],
  );
  const row = claimed.rows[0];
  assert.ok(row);

  // A committed authorize, then crashed before capture or finalize.
  const authRes = await authorizeTransaction(pool, app.acquirer, config, {
    merchantId: row.merchant_id,
    amountFils: toFils(Number(row.amount_fils)),
    card: APPROVED_CARD,
    reference: row.reference ?? undefined,
    idempotencyKey: `paylink:${row.id}:${row.reservation_id}:authorize`,
    actor: { type: "system" },
  });
  assert.equal(authRes.statusCode, 201, JSON.stringify(authRes.body));
  assert.ok(authRes.body && typeof authRes.body === "object" && "id" in authRes.body);
  const txnId = authRes.body.id;
  assert.equal(typeof txnId, "string");

  const res = await pay(link.token, APPROVED_CARD_B);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "payment_link_processing");

  const txnCount = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(txnCount.rows[0]?.c, 1);
  const finalLink = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.id],
  );
  assert.equal(finalLink.rows[0]?.status, "reserved");
});

test("an authorize 502 does not release a reservation a sibling has already authorized", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("authorize-error-sibling-wins");
  const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });

  let authCalls = 0;
  let signalAEntered: () => void = () => assert.fail("aEntered is not initialized");
  const aEntered = new Promise<void>((resolve) => {
    signalAEntered = resolve;
  });
  let releaseA: () => void = () => assert.fail("aGate is not initialized");
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const acquirer: Parameters<typeof payPaymentLink>[1] = {
    ...app.acquirer,
    authorize: async (req) => {
      authCalls += 1;
      if (authCalls === 1) {
        signalAEntered();
        await aGate;
        return { outcome: "error", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
      }
      return app.acquirer.authorize(req);
    },
  };

  // Hold A's post-502 settle (its SELECT ... FOR UPDATE on the reservation's authorize key) until
  // B has finalized, so A observes the sibling's completed authorization and must leave the paid
  // link alone rather than releasing it out from under a real charge.
  let signalSealEntered: () => void = () => assert.fail("sealEntered is not initialized");
  const sealEntered = new Promise<void>((resolve) => {
    signalSealEntered = resolve;
  });
  let releaseSeal: () => void = () => assert.fail("sealGate is not initialized");
  const sealGate = new Promise<void>((resolve) => {
    releaseSeal = resolve;
  });
  const aPool = new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await pool.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === "query") {
                return async (...args: [text: string, values?: unknown[]]) => {
                  if (args[0].includes("idempotency_keys") && args[0].includes("FOR UPDATE")) {
                    signalSealEntered();
                    await sealGate;
                  }
                  return client.query(...args);
                };
              }
              const value: unknown = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const pA = payPaymentLink(aPool, acquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
    token: link.token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  await aEntered;

  const pB = payPaymentLink(pool, acquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
    token: link.token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  // A's authorize fails; B, which blocked on A's uncommitted key, then retries and captures.
  releaseA();
  const b = await pB;
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));

  // Only now let A's settle run: it finds the key completed with 201 and leaves the paid link.
  await sealEntered;
  releaseSeal();
  const a = await pA;
  assert.equal(a.statusCode, 502, JSON.stringify(a.body));

  const txnCount = await pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(txnCount.rows[0]?.c, 1);
  assert.ok(b.body && typeof b.body === "object" && "transactionId" in b.body, JSON.stringify(b.body));
  const finalLink = await pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.id],
  );
  assert.equal(finalLink.rows[0]?.status, "paid");
  assert.equal(finalLink.rows[0]?.transaction_id, b.body.transactionId);
});

test("an authorize 502 frees the link: a different card then pays it, and a stranded link is cancelable", async () => {
  const erroringAcquirer: Parameters<typeof payPaymentLink>[1] = {
    ...app.acquirer,
    authorize: async () => ({ outcome: "error", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
  };

  // A transient acquirer error authorizes nothing, so the link must return to payable, including
  // for a buyer with a different card, who would otherwise be stuck behind the first card's key.
  {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("different-card-after-502");
    const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });

    const first = await payPaymentLink(pool, erroringAcquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
      token: link.token,
      card: APPROVED_CARD,
      idempotencyKey: randomUUID(),
    });
    assert.equal(first.statusCode, 502, JSON.stringify(first.body));

    const afterError = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
    assert.equal(afterError.rows[0]?.status, "active", "a 502 must leave the link payable again");

    const second = await payPaymentLink(pool, app.acquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
      token: link.token,
      card: APPROVED_CARD_B,
      idempotencyKey: randomUUID(),
    });
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));

    const txnCount = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(txnCount.rows[0]?.c, 1, "only the second card is charged");
    const paidLink = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
    assert.equal(paidLink.rows[0]?.status, "paid");
  }

  // The merchant can cancel a link the same 502 left reserved.
  {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("cancel-after-502");
    const link = await createLink(rawKey, merchantId, { amountFils: 3_300 });

    const first = await payPaymentLink(pool, erroringAcquirer, { paymentLinkReservationTimeoutSeconds: 0, cardFingerprintKey: config.cardFingerprintKey }, {
      token: link.token,
      card: APPROVED_CARD,
      idempotencyKey: randomUUID(),
    });
    assert.equal(first.statusCode, 502, JSON.stringify(first.body));

    const cancelRes = await app.inject({
      method: "DELETE",
      url: `/v1/merchants/${merchantId}/payment-links/${link.id}`,
      headers: authHeader(rawKey),
    });
    assert.equal(cancelRes.statusCode, 204, cancelRes.body);
    const canceled = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
    assert.equal(canceled.rows[0]?.status, "canceled");
  }
});

test("a suspended merchant's active link cannot be paid: 403 merchant_not_active, no transaction, link stays active", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("suspended");
  const link = await createLink(rawKey, merchantId, { amountFils: 5_000 });
  await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [merchantId]);

  const payRes = await pay(link.token, APPROVED_CARD);
  assert.equal(payRes.statusCode, 403, payRes.body);
  assert.equal(payRes.json().error, "merchant_not_active");

  const txns = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(txns.rowCount, 0, "no transaction may be written for a suspended merchant");
  const linkRow = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(linkRow.rows[0]!.status, "active");
});

test("create rejects a zero amount with 400, not 500 (BHA-89)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("zero-amount");
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: authHeader(rawKey),
    payload: { amountFils: 0, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_amount");
});

test("list rejects a non-numeric limit and a crafted cursor with 400, not 500 (BHA-90)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("list-bad-input");
  await createLink(rawKey, merchantId);
  const crafted = Buffer.from("not-a-date|not-a-uuid", "utf8").toString("base64url");
  const badDate = Buffer.from(`2026-13-45 99:99:99+00|${randomUUID()}`, "utf8").toString("base64url");
  for (const query of ["limit=abc", "limit=0", "limit=-5", `cursor=${crafted}`, `cursor=${badDate}`, "cursor=%%%garbage"]) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/payment-links?${query}`,
      headers: authHeader(rawKey),
    });
    assert.equal(res.statusCode, 400, `${query}: ${res.body}`);
  }
});

test("cancel with a non-UUID id answers 400, not 500 (BHA-92)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("cancel-bad-id");
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/payment-links/not-a-uuid`,
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_id");
});

test("list still accepts the nextCursor it issued", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("list-paging");
  await createLink(rawKey, merchantId, { reference: "page-a" });
  await createLink(rawKey, merchantId, { reference: "page-b" });
  const url = `/v1/merchants/${merchantId}/payment-links`;
  const first = (await app.inject({ method: "GET", url: `${url}?limit=1`, headers: authHeader(rawKey) })).json();
  assert.ok(first.nextCursor);
  const second = await app.inject({
    method: "GET",
    url: `${url}?limit=1&cursor=${first.nextCursor}`,
    headers: authHeader(rawKey),
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().paymentLinks.length, 1);
  assert.notEqual(second.json().paymentLinks[0].id, first.paymentLinks[0].id);
});
