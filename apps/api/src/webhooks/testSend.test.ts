/**
 * Unit tests for the merchant-facing "send test event" tool, using a fake
 * WebhookTransport (same layer-1 shape as dispatcher.test.ts) — no real
 * socket. Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { NotFoundError } from "../lib/errors.js";
import { createWebhookEndpoint } from "./create.js";
import { sendTestWebhookEvent } from "./testSend.js";
import { verifySignature } from "./sign.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "testSend.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
  WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Test Send Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function createEndpoint(merchantId: string, url = "http://localhost:9/receiver") {
  return createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
}

function recordingTransport(response: { statusCode: number | null; body: string }): {
  transport: WebhookTransport;
  sent: WebhookTransportRequest[];
} {
  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    sent.push(req);
    return { statusCode: response.statusCode, body: response.body };
  };
  return { transport, sent };
}

test("a reachable receiver's 200 is reported back to the caller with its body excerpt", async () => {
  const merchantId = await createMerchant("ok");
  const endpoint = await createEndpoint(merchantId, "http://localhost:9/ok");
  const { transport, sent } = recordingTransport({ statusCode: 200, body: "received" });

  const result = await sendTestWebhookEvent(pool, config, transport, {
    merchantId,
    endpointId: endpoint.id,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.responseBodyExcerpt, "received");
  assert.equal(result.timedOutOrUnreachable, false);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "http://localhost:9/ok");
  assert.equal(sent[0]!.headers["Content-Type"], "application/json");
  assert.equal(sent[0]!.timeoutMs, config.webhookRequestTimeoutMs);
});

test("the signature this call site produces verifies against the endpoint's own raw secret", async () => {
  const merchantId = await createMerchant("signature");
  const endpoint = await createEndpoint(merchantId);
  const { transport, sent } = recordingTransport({ statusCode: 200, body: "ok" });

  await sendTestWebhookEvent(pool, config, transport, { merchantId, endpointId: endpoint.id });

  const request = sent[0]!;
  const header = request.headers[WEBHOOK_SIGNATURE_HEADER];
  assert.ok(header, "every test send carries a signature header");

  // The receiver's own view: parse the body it was handed, verify against
  // the show-once secret the create response returned.
  const payload = JSON.parse(request.body) as { id: string; type: string };
  assert.equal(payload.type, "test.ping");
  assert.equal(payload.id, `test_${endpoint.id}`);

  const verified = verifySignature(payload, header, endpoint.secret);
  assert.equal(verified.valid, true, `signature must verify: ${verified.reason ?? ""}`);

  const wrongSecret = verifySignature(payload, header, "whsec_not_the_right_secret");
  assert.equal(wrongSecret.valid, false);
});

test("an unreachable receiver resolves as timedOutOrUnreachable, never throws", async () => {
  const merchantId = await createMerchant("timeout");
  const endpoint = await createEndpoint(merchantId);
  const { transport } = recordingTransport({ statusCode: null, body: "" });

  const result = await sendTestWebhookEvent(pool, config, transport, {
    merchantId,
    endpointId: endpoint.id,
  });

  assert.equal(result.statusCode, null);
  assert.equal(result.responseBodyExcerpt, null);
  assert.equal(result.timedOutOrUnreachable, true);
});

test("a receiver's error status is reported as-is, not turned into a failure of this call", async () => {
  const merchantId = await createMerchant("500");
  const endpoint = await createEndpoint(merchantId);
  const { transport } = recordingTransport({ statusCode: 500, body: "boom" });

  const result = await sendTestWebhookEvent(pool, config, transport, {
    merchantId,
    endpointId: endpoint.id,
  });

  assert.equal(result.statusCode, 500);
  assert.equal(result.responseBodyExcerpt, "boom");
  assert.equal(result.timedOutOrUnreachable, false);
});

test("a long response body is excerpted to 2000 characters", async () => {
  const merchantId = await createMerchant("long-body");
  const endpoint = await createEndpoint(merchantId);
  const { transport } = recordingTransport({ statusCode: 200, body: "x".repeat(5000) });

  const result = await sendTestWebhookEvent(pool, config, transport, {
    merchantId,
    endpointId: endpoint.id,
  });

  assert.equal(result.responseBodyExcerpt!.length, 2000);
});

// YA: tenant check is in the SQL, not after the lookup
test("another merchant's endpoint id is a 404, never a cross-tenant send", async () => {
  const ownerMerchantId = await createMerchant("owner");
  const otherMerchantId = await createMerchant("other");
  const endpoint = await createEndpoint(ownerMerchantId);
  const { transport, sent } = recordingTransport({ statusCode: 200, body: "ok" });

  await assert.rejects(
    () => sendTestWebhookEvent(pool, config, transport, { merchantId: otherMerchantId, endpointId: endpoint.id }),
    (err: unknown) => err instanceof NotFoundError && err.code === "webhook_endpoint_not_found",
  );
  assert.equal(sent.length, 0, "nothing is ever sent for an endpoint the caller doesn't own");

  await assert.rejects(
    () => sendTestWebhookEvent(pool, config, transport, { merchantId: ownerMerchantId, endpointId: randomUUID() }),
    (err: unknown) => err instanceof NotFoundError,
  );
});
