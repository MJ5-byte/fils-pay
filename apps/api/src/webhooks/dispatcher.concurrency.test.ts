/**
 * Concurrency test for BHA-135: two dispatcher replicas running at once must
 * not both send the same due delivery. Models two overlapping dispatch passes
 * against one real Postgres: replica A claims a due delivery and is held inside
 * the transport (mid-send), then replica B runs a full pass. Exactly one
 * request must reach the endpoint and the delivery must end succeeded with
 * attempt_count 1.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "dispatcher.concurrency.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
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
    [`Concurrency Test Merchant ${label} ${randomUUID()}`, 250],
  );
  const row = result.rows[0];
  if (!row) throw new Error("expected a merchants row");
  return row.id;
}

async function enqueueCaptured(merchantId: string): Promise<{ id: bigint }> {
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

test("two concurrent replicas deliver a due event exactly once (BHA-135)", async () => {
  const merchantId = await createMerchant("claim-once");
  const endpointUrl = `http://concurrency-receiver.test/webhook-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: endpointUrl,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const outboxEvent = await enqueueCaptured(merchantId);

  // Count only requests to this test's own endpoint: Step B is global and the
  // suite shares one Postgres with other test files.
  const sendsToOurUrl: string[] = [];

  // Gate held by replica A: on the first send to our URL it signals that it has
  // claimed the row and is mid-send, then blocks until released. This holds A
  // in the send window while replica B runs a full pass.
  let enteredResolve: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let gateResolve: () => void;
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });

  const replicaATransport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) {
      sendsToOurUrl.push(req.url);
      enteredResolve();
      await gate;
    }
    return { statusCode: 200, body: "ok" };
  };

  // Replica B never blocks; it records any send it makes to our URL.
  const replicaBTransport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) sendsToOurUrl.push(req.url);
    return { statusCode: 200, body: "ok" };
  };

  const passA = runDispatchPass(pool, replicaATransport, config);
  // Wait until A has claimed our delivery and is parked inside the transport.
  await entered;
  // B runs a full pass while A is mid-send. With the claim it must find our
  // row no longer due and send nothing to our URL.
  await runDispatchPass(pool, replicaBTransport, config);
  gateResolve!();
  await passA;

  assert.equal(
    sendsToOurUrl.length,
    1,
    `expected exactly one delivery to the endpoint across both replicas, got ${sendsToOurUrl.length}`,
  );

  const delivery = await pool.query<{ status: string; attempt_count: number }>(
    `SELECT status, attempt_count FROM webhook_deliveries
      WHERE outbox_event_id = $1 AND endpoint_id = $2 AND replay_of_delivery_id IS NULL`,
    [String(outboxEvent.id), endpoint.id],
  );
  const row = delivery.rows[0];
  if (!row) throw new Error("expected a webhook_deliveries row");
  assert.equal(row.status, "succeeded");
  assert.equal(row.attempt_count, 1);
});
