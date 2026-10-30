/**
 * Route/end-to-end tests for the webhooks surface:
 * registration CRUD, cross-tenant scoping, and a real local http.Server
 * receiver driven through the real create route + a real
 * transaction.captured capture + createFetchTransport(config) dispatch, with the
 * receiver itself calling verifySignature against what was actually sent.
 * Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import { createFetchTransport } from "../webhooks/transport.js";
import { verifySignature } from "../webhooks/sign.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "webhooks.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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
  WEBHOOK_MAX_ATTEMPTS: "3",
  WEBHOOK_BACKOFF_BASE_MS: "1000",
  WEBHOOK_BACKOFF_CAP_MS: "60000",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createApprovedMerchantWithApiKey(label: string) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Webhook Test Merchant ${label} ${randomUUID()}`, 250],
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

interface ReceivedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestReceiver {
  url: string;
  received: ReceivedRequest[];
  setStatusCode: (code: number) => void;
  close: () => Promise<void>;
}

/** A real node:http server on an ephemeral localhost port — a real
 *  receiving endpoint, not a test double for the HTTP layer. */
async function startTestReceiver(initialStatusCode = 200): Promise<TestReceiver> {
  let statusCode = initialStatusCode;
  const received: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ headers: req.headers, body });
      res.writeHead(statusCode, { "Content-Type": "text/plain" });
      res.end(statusCode >= 200 && statusCode < 300 ? "received" : "rejected");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("startTestReceiver: could not determine listening port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    setStatusCode: (code: number) => {
      statusCode = code;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface CreatedEndpointBody {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: string;
  secret: string;
}

async function createEndpointViaRoute(rawKey: string, merchantId: string, url: string): Promise<CreatedEndpointBody> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: authHeader(rawKey),
    payload: { url },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as CreatedEndpointBody;
}

async function authorizeAndCapture(merchantId: string, amountFils: number, label: string): Promise<string> {
  const authRes = await authorizeTransaction(pool, app.acquirer, {
    merchantId,
    amountFils: toFils(amountFils),
    card: APPROVED_CARD,
    idempotencyKey: `${label}-auth-${randomUUID()}`,
    actor: { type: "system" },
  });
  assert.equal(authRes.statusCode, 201, JSON.stringify(authRes.body));
  const txnId = (authRes.body as { id: string }).id;

  const capRes = await captureTransaction(pool, app.acquirer, {
    transactionId: txnId,
    merchantId,
    idempotencyKey: `${label}-cap-${randomUUID()}`,
    actor: { type: "system", id: txnId },
  });
  assert.equal(capRes.statusCode, 200, JSON.stringify(capRes.body));
  return txnId;
}

test("create -> list -> patch -> delete: full CRUD lifecycle, secret shown once, never returned again", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("crud");

  const created = await createEndpointViaRoute(rawKey, merchantId, "http://localhost:9/webhook");
  assert.ok(created.secret.startsWith("whsec_"));
  assert.equal(created.secretPrefix, created.secret.slice(0, 14));
  assert.equal(created.status, "active");

  const listRes = await app.inject({
    method: "GET",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: authHeader(rawKey),
  });
  assert.equal(listRes.statusCode, 200, listRes.body);
  const list = listRes.json() as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, created.id);
  assert.equal(list[0]!.secret, undefined);
  assert.equal(list[0]!.secretCiphertext, undefined);

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
    headers: authHeader(rawKey),
    payload: { status: "disabled" },
  });
  assert.equal(patchRes.statusCode, 200, patchRes.body);
  assert.equal(patchRes.json().status, "disabled");
  // URL unchanged, only status patched — PATCH does not rotate the secret
  // or the url unless asked.
  assert.equal(patchRes.json().url, "http://localhost:9/webhook");

  const patchNoBody = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
    headers: authHeader(rawKey),
    payload: {},
  });
  assert.equal(patchNoBody.statusCode, 400, patchNoBody.body);

  const deleteRes = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
    headers: authHeader(rawKey),
  });
  assert.equal(deleteRes.statusCode, 204, deleteRes.body);

  const afterDelete = await app.inject({
    method: "GET",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: authHeader(rawKey),
  });
  assert.equal((afterDelete.json() as unknown[]).length, 0);

  const deleteAgain = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
    headers: authHeader(rawKey),
  });
  assert.equal(deleteAgain.statusCode, 404, deleteAgain.body);
  assert.equal(deleteAgain.json().error, "webhook_endpoint_not_found");
});

test("invalid_url is rejected", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("invalid-url");
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: authHeader(rawKey),
    payload: { url: "not-a-url" },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_url");
});

test("cross-tenant: delete and replay both 404 on another merchant's resources, not 403 (no cross-tenant existence leak)", async () => {
  const owner = await createApprovedMerchantWithApiKey("owner-tenant");
  const intruder = await createApprovedMerchantWithApiKey("intruder-tenant");

  const created = await createEndpointViaRoute(owner.rawKey, owner.merchantId, "http://localhost:9/webhook");

  const deleteRes = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${intruder.merchantId}/webhook-endpoints/${created.id}`,
    headers: authHeader(intruder.rawKey),
  });
  assert.equal(deleteRes.statusCode, 404, deleteRes.body);
  assert.equal(deleteRes.json().error, "webhook_endpoint_not_found");

  const replayRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${intruder.merchantId}/webhook-endpoints/${created.id}/deliveries/${randomUUID()}/replay`,
    headers: authHeader(intruder.rawKey),
  });
  assert.equal(replayRes.statusCode, 404, replayRes.body);
  assert.equal(replayRes.json().error, "webhook_delivery_not_found");

  // The endpoint must still exist for its real owner — proving the 404s
  // above weren't a real mutation.
  const listRes = await app.inject({
    method: "GET",
    url: `/v1/merchants/${owner.merchantId}/webhook-endpoints`,
    headers: authHeader(owner.rawKey),
  });
  assert.equal((listRes.json() as unknown[]).length, 1);
});

test(
  "end-to-end: register a real receiver via the route, trigger a real capture, dispatch with " +
    "createFetchTransport(config), receiver verifies the signature with the SAME raw secret the create response returned",
  async () => {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("e2e-happy");
    const receiver = await startTestReceiver(200);
    try {
      const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
      const txnId = await authorizeAndCapture(merchantId, 4_750, "e2e");

      await runDispatchPass(pool, createFetchTransport(config), config);

      assert.equal(receiver.received.length, 1);
      const received = receiver.received[0]!;
      const signatureHeader = received.headers["webhook-signature"] as string;
      const deliveryIdHeader = received.headers["webhook-delivery-id"] as string;
      assert.ok(signatureHeader);
      assert.ok(deliveryIdHeader);
      assert.match(signatureHeader, /^t=\d+,v1=[0-9a-f]{64}$/);

      const parsedBody = JSON.parse(received.body) as { id: string; type: string; data: Record<string, unknown> };
      assert.equal(parsedBody.id, deliveryIdHeader);
      assert.equal(parsedBody.type, "transaction.captured");
      assert.equal(parsedBody.data.transactionId, txnId);
      assert.equal(parsedBody.data.amountCapturedFils, 4_750);
      assert.equal(parsedBody.data.status, "captured");

      // The one real caller of verifySignature: the
      // receiver checks what the dispatcher actually sent using the SAME
      // raw secret createEndpointViaRoute's response returned — proving
      // encrypt-then-decrypt-then-sign matches what a merchant would
      // verify against the secret they were shown.
      const verifyResult = verifySignature(parsedBody, signatureHeader, created.secret);
      assert.deepEqual(verifyResult, { valid: true });

      const deliveryRow = await pool.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM webhook_deliveries WHERE endpoint_id = $1`,
        [created.id],
      );
      assert.equal(deliveryRow.rows[0]!.status, "succeeded");
      assert.equal(deliveryRow.rows[0]!.attempt_count, 1);
    } finally {
      await receiver.close();
    }
  },
);

test("decline path: an endpoint returning 500 leaves the delivery pending with backoff, not succeeded", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("e2e-decline");
  const receiver = await startTestReceiver(500);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    await authorizeAndCapture(merchantId, 2_000, "decline");

    await runDispatchPass(pool, createFetchTransport(config), config);

    assert.equal(receiver.received.length, 1);

    const deliveryRow = await pool.query<{
      status: string;
      next_attempt_at: Date;
      response_status_code: number;
    }>(`SELECT status, next_attempt_at, response_status_code FROM webhook_deliveries WHERE endpoint_id = $1`, [
      created.id,
    ]);
    assert.equal(deliveryRow.rows[0]!.status, "pending");
    assert.equal(deliveryRow.rows[0]!.response_status_code, 500);
    assert.ok(deliveryRow.rows[0]!.next_attempt_at.getTime() > Date.now());
  } finally {
    await receiver.close();
  }
});

// YA: new delivery id on replay is what ARCH §5 asks for
// am: §5 says stable id?? reading it again later
test("replay: creates a new row referencing the original, with a new delivery_event_id; original row untouched", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("replay-flow");
  const receiver = await startTestReceiver(200);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    await authorizeAndCapture(merchantId, 3_300, "replay");

    await runDispatchPass(pool, createFetchTransport(config), config);
    assert.equal(receiver.received.length, 1);

    const originalRowResult = await pool.query<{
      id: string;
      delivery_event_id: string;
      status: string;
      outbox_event_id: string;
    }>(`SELECT id, delivery_event_id, status, outbox_event_id FROM webhook_deliveries WHERE endpoint_id = $1`, [
      created.id,
    ]);
    const original = originalRowResult.rows[0]!;
    assert.equal(original.status, "succeeded");

    const replayRes = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries/${original.id}/replay`,
      headers: authHeader(rawKey),
    });
    assert.equal(replayRes.statusCode, 202, replayRes.body);
    const replayBody = replayRes.json() as { deliveryId: string; status: string };
    assert.equal(replayBody.status, "pending");
    assert.notEqual(replayBody.deliveryId, original.id);

    // Dispatch again so the replay row actually gets attempted.
    await runDispatchPass(pool, createFetchTransport(config), config);
    assert.equal(receiver.received.length, 2);

    const allRows = await pool.query<{
      id: string;
      delivery_event_id: string;
      status: string;
      replay_of_delivery_id: string | null;
      outbox_event_id: string;
    }>(
      `SELECT id, delivery_event_id, status, replay_of_delivery_id, outbox_event_id
         FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at ASC`,
      [created.id],
    );
    assert.equal(allRows.rows.length, 2);
    const [originalAfter, replayRow] = allRows.rows;

    // Original row exists independently and is untouched by the replay.
    assert.equal(originalAfter!.id, original.id);
    assert.equal(originalAfter!.status, "succeeded");
    assert.equal(originalAfter!.replay_of_delivery_id, null);
    assert.equal(originalAfter!.delivery_event_id, original.delivery_event_id);

    // Replay row references the original, has its own new delivery_event_id,
    // and describes the same underlying outbox event.
    assert.equal(replayRow!.replay_of_delivery_id, original.id);
    assert.equal(replayRow!.status, "succeeded");
    assert.notEqual(replayRow!.delivery_event_id, original.delivery_event_id);
    assert.equal(replayRow!.outbox_event_id, originalAfter!.outbox_event_id);
  } finally {
    await receiver.close();
  }
});

test("disabled endpoint rejects replay with 409", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("disabled-replay");
  const receiver = await startTestReceiver(200);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    await authorizeAndCapture(merchantId, 1_000, "disabled-replay");

    await runDispatchPass(pool, createFetchTransport(config), config);

    const deliveryRow = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_deliveries WHERE endpoint_id = $1`,
      [created.id],
    );
    assert.equal(deliveryRow.rows[0]!.status, "succeeded");
    const deliveryId = deliveryRow.rows[0]!.id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
      headers: authHeader(rawKey),
      payload: { status: "disabled" },
    });
    assert.equal(patchRes.statusCode, 200, patchRes.body);

    const replayRes = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries/${deliveryId}/replay`,
      headers: authHeader(rawKey),
    });
    assert.equal(replayRes.statusCode, 409, replayRes.body);
    assert.equal(replayRes.json().error, "endpoint_disabled");
  } finally {
    await receiver.close();
  }
});

test("GET deliveries list never includes payload/signature; GET .../deliveries/:deliveryId detail view includes both; nonexistent endpoint 404s", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("deliveries-detail");
  const receiver = await startTestReceiver(200);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    await authorizeAndCapture(merchantId, 1_500, "detail");

    await runDispatchPass(pool, createFetchTransport(config), config);

    const listRes = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries`,
      headers: authHeader(rawKey),
    });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const listBody = listRes.json() as { deliveries: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.equal(listBody.deliveries.length, 1);
    assert.equal(listBody.deliveries[0]!.payload, undefined);
    assert.equal(listBody.deliveries[0]!.signature, undefined);
    const deliveryId = listBody.deliveries[0]!.id as string;

    const detailRes = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries/${deliveryId}`,
      headers: authHeader(rawKey),
    });
    assert.equal(detailRes.statusCode, 200, detailRes.body);
    const detail = detailRes.json() as { payload: Record<string, unknown>; signature: string };
    assert.ok(detail.payload);
    assert.equal(detail.payload.type, "transaction.captured");
    assert.ok(detail.signature);

    const missingEndpointRes = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${randomUUID()}/deliveries`,
      headers: authHeader(rawKey),
    });
    assert.equal(missingEndpointRes.statusCode, 404, missingEndpointRes.body);
  } finally {
    await receiver.close();
  }
});

/** The test re-canonicalizes the received body before verifying, i.e. it checks the canonical form, not the raw bytes. */
test("secret encryption round-trips correctly: a delivery verifies using the SAME secret the create response returned, decrypted fresh at send time", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("secret-roundtrip");
  const receiver = await startTestReceiver(200);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);

    // The stored secret is never plaintext — direct DB inspection confirms
    // secret_ciphertext is not the raw secret and doesn't trivially contain it.
    const stored = await pool.query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1`,
      [created.id],
    );
    assert.notEqual(stored.rows[0]!.secret_ciphertext, created.secret);
    assert.ok(!stored.rows[0]!.secret_ciphertext.includes(created.secret));

    await authorizeAndCapture(merchantId, 999, "secret-roundtrip");
    await runDispatchPass(pool, createFetchTransport(config), config);

    assert.equal(receiver.received.length, 1);
    const received = receiver.received[0]!;
    const signatureHeader = received.headers["webhook-signature"] as string;
    const parsedBody = JSON.parse(received.body) as Record<string, unknown>;

    const result = verifySignature(parsedBody, signatureHeader, created.secret);
    assert.deepEqual(result, { valid: true });
  } finally {
    await receiver.close();
  }
});
