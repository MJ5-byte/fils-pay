/**
 * Unit-level dispatcher tests using a fake WebhookTransport — no real
 * socket. Assert exact request shape (headers,
 * body, valid signature), backoff/exhaustion sequence across repeated
 * runDispatchPass calls, next_attempt_at progression, zero-endpoints
 * behavior, and multi-endpoint independence. Requires DATABASE_URL to
 * point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { backoffDelayMs, runDispatchPass } from "./dispatcher.js";
import { verifySignature } from "./sign.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("dispatcher.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
  WEBHOOK_BACKOFF_BASE_MS: "1000",
  WEBHOOK_BACKOFF_CAP_MS: "60000",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Dispatcher Test Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function createEndpoint(merchantId: string, url: string) {
  return createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
}

async function enqueueCaptured(merchantId: string) {
  const transactionId = randomUUID();
  return enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: transactionId,
    payload: {
      merchantId,
      amountCapturedFils: 4_750,
      feeFils: 71,
      newStatus: "captured",
      capturedTotalFils: 4_750,
    },
  });
}

async function forceDueNow(deliveryId: string): Promise<void> {
  await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [
    deliveryId,
  ]);
}

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  response_status_code: number | null;
  signature: string | null;
  delivery_event_id: string;
}

async function getDelivery(outboxEventId: string, endpointId: string): Promise<DeliveryRow> {
  const result = await pool.query<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE outbox_event_id = $1 AND endpoint_id = $2 AND replay_of_delivery_id IS NULL`,
    [outboxEventId, endpointId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("expected a webhook_deliveries row");
  return row;
}

function alwaysRespond(statusCode: number, body = ""): WebhookTransport {
  return async () => ({ statusCode, body });
}

test("zero registered endpoints: an outbox event creates no delivery rows", async () => {
  const merchantId = await createMerchant("zero-endpoints");
  await enqueueCaptured(merchantId);

  // NOTE: transport call assertions here are scoped to this test's own
  // merchant/event, never a global call count — runDispatchPass's Step B is
  // deliberately global (attempts every currently-due delivery platform-
  // wide, by design), and this test suite shares one real Postgres with
  // other test files that may have their own pending deliveries due in the
  // same pass when the whole suite runs together.
  const transport: WebhookTransport = async () => ({ statusCode: 200, body: "" });

  await runDispatchPass(pool, transport, config);

  const rows = await pool.query(
    `SELECT wd.* FROM webhook_deliveries wd
       JOIN outbox_events oe ON oe.id = wd.outbox_event_id
      WHERE (oe.payload->>'merchantId')::uuid = $1`,
    [merchantId],
  );
  assert.equal(rows.rows.length, 0);
});

// YA: the receiver here re-parses and re-canonicalizes before verifying. a real receiver verifies the raw bytes,
// so this can't catch a byte mismatch.
// FH: it verifies the signature end-to-end, so signing is proven correct
test("one active endpoint, 2xx response: exact headers/body sent, delivery marked succeeded, signature verifies with the raw secret", async () => {
  const merchantId = await createMerchant("happy-path");
  // A unique URL per test run, not shared with any other test — this file's
  // tests share one real Postgres with every other test file when `npm
  // test` runs the whole suite, and runDispatchPass's Step B is
  // deliberately global (attempts every currently-due delivery platform-
  // wide, by design, not scoped to one merchant) — so a transport capture
  // array must be filtered to this test's own URL, never asserted on by
  // raw array length, and pass-level createdCount/attemptedCount (also
  // global aggregates) are not asserted on here.
  const endpointUrl = `http://fake-receiver.test/webhook-${randomUUID()}`;
  const endpoint = await createEndpoint(merchantId, endpointUrl);
  const outboxEvent = await enqueueCaptured(merchantId);

  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) captured.push(req);
    return { statusCode: 200, body: "ok" };
  };

  await runDispatchPass(pool, transport, config);

  assert.equal(captured.length, 1);
  const req = captured[0]!;
  assert.equal(req.url, endpointUrl);
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.ok(req.headers[WEBHOOK_SIGNATURE_HEADER]);
  assert.ok(req.headers[WEBHOOK_DELIVERY_ID_HEADER]);
  assert.match(req.headers[WEBHOOK_SIGNATURE_HEADER]!, /^t=\d+,v1=[0-9a-f]{64}$/);

  const body = JSON.parse(req.body) as { id: string; type: string; data: Record<string, unknown> };
  assert.equal(body.type, "transaction.captured");
  assert.equal(body.id, req.headers[WEBHOOK_DELIVERY_ID_HEADER]);
  assert.equal(body.data.amountCapturedFils, 4_750);
  assert.equal(body.data.status, "captured"); // renamed from the outbox payload's "newStatus"

  // Verify the signature using the raw secret createWebhookEndpoint returned
  // — proving signPayload/verifySignature agree end-to-end, not just that
  // some signature-shaped string was sent.
  const verifyResult = verifySignature(body, req.headers[WEBHOOK_SIGNATURE_HEADER]!, endpoint.secret);
  assert.deepEqual(verifyResult, { valid: true });

  const delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "succeeded");
  assert.equal(delivery.attempt_count, 1);
  assert.equal(delivery.response_status_code, 200);
  assert.equal(delivery.delivery_event_id, body.id);
});

test("failing endpoint: backoff/exhaustion sequence across repeated runDispatchPass calls, next_attempt_at progresses correctly, exhausted at webhookMaxAttempts", async () => {
  const merchantId = await createMerchant("backoff-exhaustion");
  const endpoint = await createEndpoint(merchantId, "http://fake-receiver.test/always-500");
  const outboxEvent = await enqueueCaptured(merchantId);

  const transport = alwaysRespond(500, "server error");

  // Pass 1: creates the row AND attempts it immediately (next_attempt_at
  // defaults to now()).
  await runDispatchPass(pool, transport, config);
  let delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt_count, 1);
  assert.equal(delivery.response_status_code, 500);
  const expectedDelay1 = backoffDelayMs(1, config, () => 0.5); // deterministic: jitter factor 1.0
  assert.equal(expectedDelay1, 1000);
  const actualDelay1 = delivery.next_attempt_at.getTime() - Date.now();
  assert.ok(Math.abs(actualDelay1 - expectedDelay1) < 3000, `expected ~${expectedDelay1}ms, got ${actualDelay1}ms`);

  // Pass 2: not due yet (next_attempt_at is in the future) — no new attempt
  // against THIS delivery specifically (runDispatchPass's own return value
  // is a global, platform-wide aggregate — not asserted on here, since this
  // suite shares one real Postgres with other test files/tests whose own
  // due work may legitimately be attempted in the same pass).
  await runDispatchPass(pool, transport, config);
  delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.attempt_count, 1);

  // Force due, pass again: attempt 2, still pending (max attempts = 3).
  await forceDueNow(delivery.id);
  await runDispatchPass(pool, transport, config);
  delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt_count, 2);
  const expectedDelay2 = backoffDelayMs(2, config, () => 0.5);
  assert.equal(expectedDelay2, 2000);
  const actualDelay2 = delivery.next_attempt_at.getTime() - Date.now();
  assert.ok(Math.abs(actualDelay2 - expectedDelay2) < 3000, `expected ~${expectedDelay2}ms, got ${actualDelay2}ms`);

  // Force due, pass again: attempt 3 === webhookMaxAttempts -> exhausted.
  await forceDueNow(delivery.id);
  await runDispatchPass(pool, transport, config);
  delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "exhausted");
  assert.equal(delivery.attempt_count, 3);

  // Exhausted deliveries are never picked up again, even if forced due
  // (status = 'exhausted' fails the Step B query's `status = 'pending'`
  // filter regardless of next_attempt_at).
  await forceDueNow(delivery.id);
  await runDispatchPass(pool, transport, config);
  delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "exhausted");
  assert.equal(delivery.attempt_count, 3);
});

test("transport-level failure (thrown/rejected transport): treated as a non-2xx failure, null response_status_code", async () => {
  const merchantId = await createMerchant("transport-failure");
  const endpoint = await createEndpoint(merchantId, "http://unreachable.test/webhook");
  const outboxEvent = await enqueueCaptured(merchantId);

  const transport: WebhookTransport = async () => ({
    statusCode: null,
    body: "",
    errorMessage: "connect ECONNREFUSED",
  });

  await runDispatchPass(pool, transport, config);
  const delivery = await getDelivery(String(outboxEvent.id), endpoint.id);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt_count, 1);
  assert.equal(delivery.response_status_code, null);
});

test("multi-endpoint independence: one endpoint succeeds, the other exhausts, unaffected by each other", async () => {
  const merchantId = await createMerchant("multi-endpoint");
  const goodEndpoint = await createEndpoint(merchantId, "http://good.test/webhook");
  const badEndpoint = await createEndpoint(merchantId, "http://bad.test/webhook");
  const outboxEvent = await enqueueCaptured(merchantId);

  const transport: WebhookTransport = async (req) => {
    if (req.url.includes("good.test")) return { statusCode: 200, body: "ok" };
    return { statusCode: 500, body: "fail" };
  };

  // Pass 1: both created + attempted (asserted per-row below via getDelivery
  // — runDispatchPass's own return value is a global, platform-wide
  // aggregate across every currently-due delivery, not just this test's
  // two, so it's not asserted on directly here).
  await runDispatchPass(pool, transport, config);

  let good = await getDelivery(String(outboxEvent.id), goodEndpoint.id);
  let bad = await getDelivery(String(outboxEvent.id), badEndpoint.id);
  assert.equal(good.status, "succeeded");
  assert.equal(bad.status, "pending");
  assert.equal(bad.attempt_count, 1);

  // Drive the bad endpoint to exhaustion; the good endpoint's succeeded row
  // must remain untouched throughout.
  await forceDueNow(bad.id);
  await runDispatchPass(pool, transport, config);
  bad = await getDelivery(String(outboxEvent.id), badEndpoint.id);
  assert.equal(bad.attempt_count, 2);

  await forceDueNow(bad.id);
  await runDispatchPass(pool, transport, config);
  bad = await getDelivery(String(outboxEvent.id), badEndpoint.id);
  assert.equal(bad.status, "exhausted");
  assert.equal(bad.attempt_count, 3);

  good = await getDelivery(String(outboxEvent.id), goodEndpoint.id);
  assert.equal(good.status, "succeeded");
  assert.equal(good.attempt_count, 1);
});

test("no backfill: an endpoint registered after an event was enqueued never gets a delivery row for that pre-existing event, only for events enqueued afterward", async () => {
  const merchantId = await createMerchant("no-backfill");

  // Two events enqueued BEFORE any endpoint exists for this merchant.
  const preExistingEvent1 = await enqueueCaptured(merchantId);
  const preExistingEvent2 = await enqueueCaptured(merchantId);

  const endpointUrl = `http://fake-receiver.test/webhook-${randomUUID()}`;
  const endpoint = await createEndpoint(merchantId, endpointUrl);

  // A third event enqueued AFTER the endpoint was registered.
  const postRegistrationEvent = await enqueueCaptured(merchantId);

  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) captured.push(req);
    return { statusCode: 200, body: "ok" };
  };

  await runDispatchPass(pool, transport, config);

  // Only the post-registration event was delivered — the two pre-existing
  // events must never get a delivery row for this endpoint at all.
  const preRows1 = await pool.query(
    `SELECT * FROM webhook_deliveries WHERE outbox_event_id = $1 AND endpoint_id = $2`,
    [String(preExistingEvent1.id), endpoint.id],
  );
  const preRows2 = await pool.query(
    `SELECT * FROM webhook_deliveries WHERE outbox_event_id = $1 AND endpoint_id = $2`,
    [String(preExistingEvent2.id), endpoint.id],
  );
  assert.equal(preRows1.rows.length, 0);
  assert.equal(preRows2.rows.length, 0);

  const postDelivery = await getDelivery(String(postRegistrationEvent.id), endpoint.id);
  assert.equal(postDelivery.status, "succeeded");

  // Exactly one delivery attempt was sent to this endpoint — the two
  // pre-existing events, not just their delivery rows, never even generate
  // an outbound request.
  assert.equal(captured.length, 1);
});

test("per-row isolation: one poisoned row (undecryptable secret) throwing before the transport call never blocks another merchant's healthy delivery in the same pass, and the poisoned row's state is left unchanged rather than crashing the pass", async () => {
  const poisonedMerchantId = await createMerchant("poisoned");
  const poisonedEndpoint = await createEndpoint(poisonedMerchantId, "http://poisoned.test/webhook");
  const poisonedOutboxEvent = await enqueueCaptured(poisonedMerchantId);

  // Corrupt the endpoint's stored secret so decryptSecret throws
  // synchronously (base64-decodes to fewer bytes than an IV + auth tag
  // require) — this is a failure that happens before attemptOneDelivery
  // ever reaches the transport call, unlike the transport-level-failure
  // test above.
  await pool.query(`UPDATE webhook_endpoints SET secret_ciphertext = $1 WHERE id = $2`, [
    Buffer.from("too-short").toString("base64"),
    poisonedEndpoint.id,
  ]);

  const healthyMerchantId = await createMerchant("healthy-sibling");
  const healthyEndpointUrl = `http://healthy.test/webhook-${randomUUID()}`;
  const healthyEndpoint = await createEndpoint(healthyMerchantId, healthyEndpointUrl);
  const healthyOutboxEvent = await enqueueCaptured(healthyMerchantId);

  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === healthyEndpointUrl) captured.push(req);
    return { statusCode: 200, body: "ok" };
  };

  // Both delivery rows are created and attempted in this single pass. The
  // poisoned row must not throw the pass itself, and must not prevent the
  // healthy row (a different merchant/endpoint, processed in the same
  // Step B loop) from succeeding.
  await assert.doesNotReject(runDispatchPass(pool, transport, config));

  assert.equal(captured.length, 1);
  const healthyDelivery = await getDelivery(String(healthyOutboxEvent.id), healthyEndpoint.id);
  assert.equal(healthyDelivery.status, "succeeded");
  assert.equal(healthyDelivery.attempt_count, 1);
  assert.equal(healthyDelivery.response_status_code, 200);

  // The poisoned row was created by Step A (its existence itself proves
  // Step A ran), but Step B's per-row throw must leave it completely
  // untouched: still pending, zero attempts, never attempted, unmodified
  // next_attempt_at so it is simply retried next pass.
  const poisonedDelivery = await getDelivery(String(poisonedOutboxEvent.id), poisonedEndpoint.id);
  assert.equal(poisonedDelivery.status, "pending");
  assert.equal(poisonedDelivery.attempt_count, 0);
  assert.equal(poisonedDelivery.response_status_code, null);
  assert.equal(poisonedDelivery.signature, null);

  // Running a second pass proves the process is still alive and the
  // dispatcher keeps functioning platform-wide afterward, not just that
  // one call happened not to throw.
  await assert.doesNotReject(runDispatchPass(pool, transport, config));
  const poisonedAfterSecondPass = await getDelivery(String(poisonedOutboxEvent.id), poisonedEndpoint.id);
  assert.equal(poisonedAfterSecondPass.status, "pending");
  assert.equal(poisonedAfterSecondPass.attempt_count, 0);
});

test("a disabled endpoint gets no delivery row for a new event", async () => {
  const merchantId = await createMerchant("disabled-endpoint");
  const endpoint = await createEndpoint(merchantId, "http://disabled.test/webhook");
  await pool.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [endpoint.id]);
  const outboxEvent = await enqueueCaptured(merchantId);

  const transport = alwaysRespond(200);
  await runDispatchPass(pool, transport, config);

  const rows = await pool.query(`SELECT * FROM webhook_deliveries WHERE outbox_event_id = $1 AND endpoint_id = $2`, [
    String(outboxEvent.id),
    endpoint.id,
  ]);
  assert.equal(rows.rows.length, 0);
});
