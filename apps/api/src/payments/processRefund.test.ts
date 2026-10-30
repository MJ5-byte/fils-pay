/**
 * Tests for the refund processor against a real, migrated Postgres (no DB
 * mocking). Requires `DATABASE_URL` (run `npm run migrate` first).
 *
 * There is no route to `inject` against yet — `POST /v1/refunds` is still a
 * 501 stub — so these call `processRefund()` directly. The transactions they
 * refund are set up through the real authorize/capture routes, so the ledger
 * and fee state under test is the state capture actually produces.
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
  throw new Error(
    "processRefund.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
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

/** An acquirer whose refund outcome is fixed, so a decline or a transport
 *  error is exercised without depending on the simulator's RNG. */
function fixedAcquirer(outcome: AcquirerOutcome): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("fixedAcquirer: authorize is not used by these tests");
    },
    capture() {
      throw new Error("fixedAcquirer: capture is not used by these tests");
    },
    refund(req): Promise<AcquirerRefundResult> {
      return Promise.resolve({ outcome, acquirerReference: req.acquirerReference, latencyMs: 0 });
    },
  };
}

const approvingAcquirer = fixedAcquirer("approved");

async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Merchant ${label} ${randomUUID()}`, mdrBps],
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

/** Authorizes `amountFils` and captures `captureFils` (everything, by
 *  default) through the real routes, returning the transaction id. */
async function capturedTransaction(
  rawKey: string,
  amountFils: number,
  captureFils?: number,
): Promise<{ id: string }> {
  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-test" },
  });
  assert.equal(authorizeRes.statusCode, 201, authorizeRes.body);
  const txn = authorizeRes.json() as { id: string };

  const captureRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(captureRes.statusCode, 200, captureRes.body);

  return { id: txn.id };
}

/** The api key these tests already hold, as a writer actor — the same shape
 *  `requireMerchantWriterActor()` hands the route layer. */
async function apiKeyActor(merchantId: string): Promise<{ type: "merchant_api_key"; id: string }> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("apiKeyActor: no api key for merchant");
  return { type: "merchant_api_key", id: row.id };
}

test("a full refund of a fully captured transaction lands on refunded", async () => {
  const merchant = await createApprovedMerchantWithApiKey("full-refund");
  const txn = await capturedTransaction(merchant.rawKey, 10_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(10_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  const row = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(row.rows[0]!.status, "refunded");
  assert.equal(Number(row.rows[0]!.refunded_fils), 10_000);

  const refunds = await pool.query<{ amount_fils: string; fee_reversed_fils: string; status: string }>(
    `SELECT amount_fils, fee_reversed_fils, status FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows.length, 1);
  assert.equal(Number(refunds.rows[0]!.amount_fils), 10_000);
  assert.equal(refunds.rows[0]!.status, "succeeded");

  const events = await pool.query<{ event_type: string; amount_fils: string | null }>(
    `SELECT event_type, amount_fils FROM transaction_events WHERE transaction_id = $1 ORDER BY id`,
    [txn.id],
  );
  const last = events.rows[events.rows.length - 1]!;
  assert.equal(last.event_type, "refunded");
  assert.equal(Number(last.amount_fils), -10_000);
});

/**
 * Proves the reversal group balances (sum of debits == sum of credits) and
 * that, summed over all partial refunds of one capture, fee_reversed_fils
 * equals the capture's fee exactly.
 */
test("the refund's ledger group balances and reverses the fee that was charged", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-ledger", 250);
  const txn = await capturedTransaction(merchant.rawKey, 10_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const feeCharged = await pool.query<{ fee: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS fee
       FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue' AND direction = 'credit'`,
    [txn.id],
  );
  assert.equal(Number(feeCharged.rows[0]!.fee), 250);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  // A single full refund reverses exactly the fee that was charged.
  const refund = await pool.query<{ fee_reversed_fils: string }>(
    `SELECT fee_reversed_fils FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(Number(refund.rows[0]!.fee_reversed_fils), 250);

  // The reversal legs share one entry_group_id and net to zero — the
  // deferred ledger_entries_balance trigger would have refused the commit
  // otherwise, but assert it rather than infer it.
  const groups = await pool.query<{ entry_group_id: string; net: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries
      WHERE transaction_id = $1
      GROUP BY entry_group_id`,
    [txn.id],
  );
  assert.equal(groups.rows.length, 2, "one group for the capture, one for the refund");
  for (const group of groups.rows) {
    assert.equal(Number(group.net), 0);
  }

  const reversalLegs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils
       FROM ledger_entries
      WHERE transaction_id = $1 AND description LIKE 'refund:%'`,
    [txn.id],
  );
  const byLeg = new Map(reversalLegs.rows.map((r) => [`${r.account_id}:${r.direction}`, Number(r.amount_fils)]));
  assert.equal(byLeg.get("merchant_payable:debit"), 10_000);
  assert.equal(byLeg.get("card_scheme_clearing:credit"), 10_000);
  assert.equal(byLeg.get("platform_fee_revenue:debit"), 250);
  assert.equal(byLeg.get("merchant_payable:credit"), 250);
});

test("a partial refund lands on partially_refunded with a refund_partial event", async () => {
  const merchant = await createApprovedMerchantWithApiKey("partial-refund");
  const txn = await capturedTransaction(merchant.rawKey, 10_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(4_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  const row = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(row.rows[0]!.status, "partially_refunded");
  assert.equal(Number(row.rows[0]!.refunded_fils), 4_000);

  const events = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM transaction_events WHERE transaction_id = $1 ORDER BY id`,
    [txn.id],
  );
  assert.equal(events.rows[events.rows.length - 1]!.event_type, "refund_partial");
});

// am: should there be a test for two refunds at the SAME time? nvm the claim blocks it
test("a second partial refund completing the captured total lands on refunded", async () => {
  const merchant = await createApprovedMerchantWithApiKey("two-partials");
  const txn = await capturedTransaction(merchant.rawKey, 10_000);
  const actor = await apiKeyActor(merchant.merchantId);

  for (const amount of [6_000, 4_000]) {
    const result = await processRefund(pool, approvingAcquirer, {
      transactionId: txn.id,
      merchantId: merchant.merchantId,
      amountFils: toFils(amount),
      idempotencyKey: randomUUID(),
      actor,
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  }

  const row = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(row.rows[0]!.status, "refunded");
  assert.equal(Number(row.rows[0]!.refunded_fils), 10_000);

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows[0]!.c, 2);
});

/** Replay = same key AND same body. A different body under the same key is a 422 (covered in idempotency.test.ts). */
test("replaying the same idempotency key returns the first body and writes nothing new", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-replay");
  const txn = await capturedTransaction(merchant.rawKey, 8_000);
  const actor = await apiKeyActor(merchant.merchantId);
  const key = randomUUID();

  const first = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: key,
    actor,
  });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));

  const second = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: key,
    actor,
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, first.body);

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows[0]!.c, 1);

  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [
    txn.id,
  ]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 3_000);
});

test("a declined refund answers 402 and writes no refund, ledger entry or event", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-declined");
  const txn = await capturedTransaction(merchant.rawKey, 5_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const ledgerBefore = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM ledger_entries WHERE transaction_id = $1`,
    [txn.id],
  );

  const result = await processRefund(pool, fixedAcquirer("declined"), {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 402);
  assert.deepEqual(result.body, { error: "refund_declined" });

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows[0]!.c, 0);

  const ledgerAfter = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM ledger_entries WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(ledgerAfter.rows[0]!.c, ledgerBefore.rows[0]!.c);

  const row = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(row.rows[0]!.status, "captured");
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
});

test("an acquirer transport error answers 502 and leaves the key retryable", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-error");
  const txn = await capturedTransaction(merchant.rawKey, 5_000);
  const actor = await apiKeyActor(merchant.merchantId);
  const key = randomUUID();

  const result = await processRefund(pool, fixedAcquirer("error"), {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: key,
    actor,
  });
  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, { error: "acquirer_unavailable" });

  const claim = await pool.query<{ status: string }>(
    `SELECT status FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = 'refunds.create' AND key = $2`,
    [merchant.merchantId, key],
  );
  assert.equal(claim.rows[0]!.status, "failed");

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows[0]!.c, 0);

  // A retry with the same key re-attempts rather than replaying the failure.
  const retry = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: key,
    actor,
  });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
});

test("a refund against a voided transaction is refused by the validator", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-voided");
  const actor = await apiKeyActor(merchant.merchantId);

  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card: VALID_CARD, reference: "refund-void" },
  });
  assert.equal(authorizeRes.statusCode, 201, authorizeRes.body);
  const txn = authorizeRes.json() as { id: string };

  const voidRes = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txn.id}/void`,
    headers: { authorization: `Bearer ${merchant.rawKey}` },
  });
  assert.equal(voidRes.statusCode, 200, voidRes.body);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(1_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.body, { ok: false, code: "transaction_not_refundable", status: "voided" });

  const refunds = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(refunds.rows[0]!.c, 0);
});

test("a successful refund enqueues exactly one refund.succeeded outbox event", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-outbox");
  const txn = await capturedTransaction(merchant.rawKey, 7_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(7_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));

  const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type, payload FROM outbox_events
      WHERE aggregate_id = $1 AND event_type = 'refund.succeeded'`,
    [txn.id],
  );
  assert.equal(events.rows.length, 1);
  // dispatcher.ts joins webhook endpoints on payload->>'merchantId', so an
  // event without it would be silently undeliverable.
  assert.equal(events.rows[0]!.payload.merchantId, merchant.merchantId);
  assert.equal(events.rows[0]!.payload.amountFils, 7_000);
});

// TODO(FH): add "another merchant's transaction answers 404" — Claude says it's covered
// by the route test already
test("unknown transaction ids answer 404", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-missing");
  const actor = await apiKeyActor(merchant.merchantId);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: randomUUID(),
    merchantId: merchant.merchantId,
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { error: "transaction_not_found" });
});

test("two concurrent full refunds of one captured transaction pay out once", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-race");
  const txn = await capturedTransaction(merchant.rawKey, 10_000);
  const actor = await apiKeyActor(merchant.merchantId);
  let refundCalls = 0;
  let releaseFirstRefund: (() => void) | undefined;
  const acquirer: AcquirerSimulator = {
    ...fixedAcquirer("approved"),
    async refund(req): Promise<AcquirerRefundResult> {
      refundCalls += 1;
      if (refundCalls === 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          releaseFirstRefund = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      } else {
        releaseFirstRefund?.();
      }
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };

  const results = await Promise.allSettled([
    processRefund(pool, acquirer, {
      transactionId: txn.id,
      merchantId: merchant.merchantId,
      amountFils: toFils(10_000),
      idempotencyKey: randomUUID(),
      reason: "requested_by_customer",
      actor,
    }),
    processRefund(pool, acquirer, {
      transactionId: txn.id,
      merchantId: merchant.merchantId,
      amountFils: toFils(10_000),
      idempotencyKey: randomUUID(),
      reason: "requested_by_customer",
      actor,
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 2, "both refund requests must resolve");
  assert.deepEqual(fulfilled.map((result) => result.value.statusCode).sort(), [200, 409]);
  assert.equal(refundCalls, 1);

  const row = await pool.query<{ refunded_fils: string }>(
    `SELECT refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(Number(row.rows[0]?.refunded_fils), 10_000);

  const refunds = await pool.query<{ count: string }>(
    `SELECT count(*) FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(Number(refunds.rows[0]?.count), 1);
});

test("a refund above captured minus refunded on a partially captured transaction is refused", async () => {
  const merchant = await createApprovedMerchantWithApiKey("refund-above-captured");
  const txn = await capturedTransaction(merchant.rawKey, 10_000, 4_000);
  const actor = await apiKeyActor(merchant.merchantId);

  const result = await processRefund(pool, approvingAcquirer, {
    transactionId: txn.id,
    merchantId: merchant.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: randomUUID(),
    reason: "requested_by_customer",
    actor,
  });
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.body, { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });

  const row = await pool.query<{ refunded_fils: string }>(
    `SELECT refunded_fils FROM transactions WHERE id = $1`,
    [txn.id],
  );
  assert.equal(Number(row.rows[0]?.refunded_fils), 0);

  const refunds = await pool.query<{ count: string }>(
    `SELECT count(*) FROM refunds WHERE transaction_id = $1`,
    [txn.id],
  );
  assert.equal(Number(refunds.rows[0]?.count), 0);
});
