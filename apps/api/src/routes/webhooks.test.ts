/**
 * Route/end-to-end tests for the webhooks surface:
 * registration CRUD, cross-tenant scoping, and a real local http.Server
 * receiver driven through the real create route + a real
 * transaction.captured capture + createFetchTransport() dispatch, with the
 * receiver itself calling verifySignature against what was actually sent.
 * Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
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
  WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
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
  const authRes = await authorizeTransaction(pool, app.acquirer, config, {
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
    "createFetchTransport(), receiver verifies the signature with the SAME raw secret the create response returned",
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

test("with WEBHOOK_ALLOW_PRIVATE_TARGETS off, a loopback endpoint is refused at create and test send reaches nothing", async () => {
  const blockedConfig = { ...config, webhookAllowPrivateTargets: false };
  const blockedApp = buildApp(blockedConfig, pool);
  const receiver = await startTestReceiver();
  try {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("blocked-loopback");
    const createRes = await blockedApp.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      headers: authHeader(rawKey),
      payload: { url: receiver.url },
    });
    assert.equal(createRes.statusCode, 400, createRes.body);
    assert.equal(createRes.json().error, "invalid_url");

    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    const testRes = await blockedApp.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/test`,
      headers: authHeader(rawKey),
    });
    assert.equal(testRes.statusCode, 200, testRes.body);
    assert.equal(testRes.json().responseBodyExcerpt, null);
    assert.equal(testRes.json().statusCode, null);
    assert.equal(receiver.received.length, 0);
  } finally {
    await receiver.close();
    await blockedApp.close();
  }
});

test("with WEBHOOK_ALLOW_PRIVATE_TARGETS off, create and update refuse CGNAT, NAT64 and IPv4-compatible targets and a trailing-dot localhost", async () => {
  const blockedConfig = { ...config, webhookAllowPrivateTargets: false };
  const blockedApp = buildApp(blockedConfig, pool);
  try {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("blocked-resolved");
    const created = await createEndpointViaRoute(rawKey, merchantId, "https://example.test/webhook");
    // 100.100.100.200 is a cloud metadata address; "localhost." must not slip past the localhost check by its trailing dot.
    for (const url of [
      "https://100.100.100.200/latest/meta-data",
      "https://[64:ff9b::a9fe:a9fe]/",
      "https://[64:ff9b:1::a9fe:a9fe]/",
      "https://[::7f00:1]/",
      "https://localhost./webhook",
    ]) {
      const createRes = await blockedApp.inject({
        method: "POST",
        url: `/v1/merchants/${merchantId}/webhook-endpoints`,
        headers: authHeader(rawKey),
        payload: { url },
      });
      assert.equal(createRes.statusCode, 400, `${url}: ${createRes.body}`);
      assert.equal(createRes.json().error, "invalid_url");

      const updateRes = await blockedApp.inject({
        method: "PATCH",
        url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
        headers: authHeader(rawKey),
        payload: { url },
      });
      assert.equal(updateRes.statusCode, 400, `${url}: ${updateRes.body}`);
      assert.equal(updateRes.json().error, "invalid_url");
    }
  } finally {
    await blockedApp.close();
  }
});

test("with WEBHOOK_ALLOW_PRIVATE_TARGETS off, create and update refuse a hostname whose DNS answer is loopback", async () => {
  const blockedConfig = { ...config, webhookAllowPrivateTargets: false };
  const blockedApp = buildApp(blockedConfig, pool);
  mock.method(dns.promises, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  syncBuiltinESMExports();
  try {
    const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("blocked-dns");
    const created = await createEndpointViaRoute(rawKey, merchantId, "https://example.test/webhook");
    const url = "https://rebind.example.test/webhook";

    const createRes = await blockedApp.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      headers: authHeader(rawKey),
      payload: { url },
    });
    assert.equal(createRes.statusCode, 400, createRes.body);
    assert.equal(createRes.json().error, "invalid_url");

    const updateRes = await blockedApp.inject({
      method: "PATCH",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}`,
      headers: authHeader(rawKey),
      payload: { url },
    });
    assert.equal(updateRes.statusCode, 400, updateRes.body);
    assert.equal(updateRes.json().error, "invalid_url");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await blockedApp.close();
  }
});

test("with WEBHOOK_ALLOW_PRIVATE_TARGETS off, the transport refuses CGNAT, NAT64 and IPv4-compatible addresses before connecting", async () => {
  const transport = createFetchTransport({ webhookAllowPrivateTargets: false });
  for (const url of [
    "http://100.100.100.200/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b:1::a9fe:a9fe]/",
    "http://[::7f00:1]/",
  ]) {
    const response = await transport({ url, headers: {}, body: "{}", timeoutMs: 200 });
    assert.equal(response.statusCode, null, url);
    assert.equal(response.errorMessage, "webhook target address is not allowed", url);
  }
});

test("the transport does not follow redirects", async () => {
  const target = await startTestReceiver();
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: target.url });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  try {
    const address = redirector.address();
    assert.ok(address && typeof address !== "string");
    const response = await createFetchTransport(config)({
      url: `http://127.0.0.1:${address.port}/`,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
    });
    assert.equal(response.statusCode, 302);
    assert.equal(target.received.length, 0);
  } finally {
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await target.close();
  }
});

// BHA-91 / BHA-93: bad limit, bad cursor and non-UUID ids must answer 4xx, never 500.
test("GET deliveries answers 400 for a non-numeric limit and for a crafted cursor", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("bad-limit");
  const endpoint = await createEndpointViaRoute(rawKey, merchantId, "http://127.0.0.1:9/webhook");
  const base = `/v1/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/deliveries`;

  const badLimit = await app.inject({ method: "GET", url: `${base}?limit=abc`, headers: authHeader(rawKey) });
  assert.equal(badLimit.statusCode, 400, badLimit.body);

  const crafted = Buffer.from(`not-a-date|not-a-uuid`, "utf8").toString("base64url");
  const badCursor = await app.inject({ method: "GET", url: `${base}?cursor=${crafted}`, headers: authHeader(rawKey) });
  assert.equal(badCursor.statusCode, 400, badCursor.body);
});

test("webhook endpoint routes answer 404 for a non-UUID endpoint or delivery id", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("bad-id");
  const base = `/v1/merchants/${merchantId}/webhook-endpoints`;
  const calls: Array<[string, string, string]> = [
    ["GET", `${base}/nope/deliveries`, "deliveries list"],
    ["GET", `${base}/nope/deliveries/nope`, "delivery detail"],
    ["PATCH", `${base}/nope`, "update"],
    ["DELETE", `${base}/nope`, "delete"],
    ["POST", `${base}/nope/test`, "test send"],
    ["POST", `${base}/nope/deliveries/nope/replay`, "replay"],
  ];
  for (const [method, url, label] of calls) {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: authHeader(rawKey),
      ...(method === "PATCH" ? { payload: { status: "disabled" } } : {}),
    });
    assert.equal(res.statusCode, 404, `${label}: ${res.statusCode} ${res.body}`);
  }
});

test("GET deliveries?status=failed returns the real permanently-failed (exhausted) deliveries (BHA-143)", async () => {
  const { rawKey, merchantId } = await createApprovedMerchantWithApiKey("failed-filter");
  const receiver = await startTestReceiver(500);
  try {
    const created = await createEndpointViaRoute(rawKey, merchantId, receiver.url);
    await authorizeAndCapture(merchantId, 1_500, "failed-filter");

    // Drive the one delivery to 'exhausted' (WEBHOOK_MAX_ATTEMPTS = 3): pass 1
    // creates and attempts it, then force it due and pass twice more.
    await runDispatchPass(pool, createFetchTransport(config), config);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await pool.query(
        `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE endpoint_id = $1`,
        [created.id],
      );
      await runDispatchPass(pool, createFetchTransport(config), config);
    }

    const stored = await pool.query<{ status: string }>(
      `SELECT status FROM webhook_deliveries WHERE endpoint_id = $1`,
      [created.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]!.status, "exhausted");

    // The bug: filtering by 'failed' used to match the never-written 'failed'
    // status and always return zero rows. It must now surface the exhausted row.
    const failedRes = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries?status=failed`,
      headers: authHeader(rawKey),
    });
    assert.equal(failedRes.statusCode, 200, failedRes.body);
    const failedBody = failedRes.json() as { deliveries: Array<{ status: string }> };
    assert.equal(failedBody.deliveries.length, 1);
    assert.equal(failedBody.deliveries[0]!.status, "exhausted");

    // The mapping is narrow, not a catch-all: 'succeeded' still matches nothing here.
    const succeededRes = await app.inject({
      method: "GET",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${created.id}/deliveries?status=succeeded`,
      headers: authHeader(rawKey),
    });
    assert.equal(succeededRes.statusCode, 200, succeededRes.body);
    const succeededBody = succeededRes.json() as { deliveries: unknown[] };
    assert.equal(succeededBody.deliveries.length, 0);
  } finally {
    await receiver.close();
  }
});
