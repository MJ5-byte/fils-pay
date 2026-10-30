/**
 * Unit tests for webhook delivery archive capture and restore, against a
 * real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  createWebhookDeliveryArchive,
  replayWebhookDeliveryArchive,
  type ArchivedDeliveryEntry,
} from "./archiveReplay.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "archiveReplay.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Archive Replay Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function createAdminUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Archive Replay Test', 'finance') RETURNING id`,
    [`archive-replay-${randomUUID()}@admin.test`],
  );
  return result.rows[0]!.id;
}

async function createEndpoint(merchantId: string, status: "active" | "disabled" = "active"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints
        (merchant_id, url, secret_ciphertext, secret_prefix, status, created_by_type, created_by_id)
     VALUES ($1, $2, 'unused-in-these-tests', 'whsec_testpre', $3, 'merchant_session', $4)
     RETURNING id`,
    [merchantId, `https://receiver.test/${randomUUID()}`, status, randomUUID()],
  );
  return result.rows[0]!.id;
}

async function insertDelivery(
  endpointId: string,
  opts: { eventType: string; createdAt: string },
): Promise<string> {
  // The outbox row is shared with other consumers (apps/reporting reads every
  // transaction.* event), so it carries the same payload shape the real
  // producers in payments/capture.ts and void.ts emit.
  const outboxPayload =
    opts.eventType === "transaction.captured"
      ? { amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 }
      : {};
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     SELECT $1, 'transaction', $2,
            $3::jsonb || jsonb_build_object('merchantId', e.merchant_id)
       FROM webhook_endpoints e
      WHERE e.id = $4
     RETURNING id`,
    [opts.eventType, randomUUID(), JSON.stringify(outboxPayload), endpointId],
  );
  const outboxEventId = outbox.rows[0]!.id;

  const deliveryEventId = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
        (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      endpointId,
      outboxEventId,
      opts.eventType,
      deliveryEventId,
      JSON.stringify({ id: deliveryEventId, type: opts.eventType, data: { marker: opts.createdAt } }),
      opts.createdAt,
    ],
  );
  return result.rows[0]!.id;
}

// FH: window dates are from the May seed, update if the seed changes
const WINDOW = { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-10T00:00:00Z") };

test("captures every delivery in the window, in capture order, round-tripping as JSON", async () => {
  const merchantId = await createMerchant();
  const adminUserId = await createAdminUser();
  const endpointId = await createEndpoint(merchantId);

  const ids = [
    await insertDelivery(endpointId, { eventType: "transaction.captured", createdAt: "2026-05-02T00:00:00Z" }),
    await insertDelivery(endpointId, { eventType: "transaction.voided", createdAt: "2026-05-03T00:00:00Z" }),
    await insertDelivery(endpointId, { eventType: "transaction.captured", createdAt: "2026-05-04T00:00:00Z" }),
  ];
  // Outside the window on both sides — neither belongs in the archive.
  await insertDelivery(endpointId, { eventType: "transaction.captured", createdAt: "2026-04-30T00:00:00Z" });
  await insertDelivery(endpointId, { eventType: "transaction.captured", createdAt: "2026-05-10T00:00:00Z" });

  const created = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId,
    adminUserId,
    ...WINDOW,
  });

  assert.equal(created.deliveryCount, 3);

  const stored = await pool.query<{ archive_payload: string; delivery_count: number }>(
    `SELECT archive_payload, delivery_count FROM webhook_delivery_archives WHERE id = $1`,
    [created.archiveId],
  );
  assert.equal(stored.rows[0]!.delivery_count, 3);

  const entries = JSON.parse(stored.rows[0]!.archive_payload) as ArchivedDeliveryEntry[];
  assert.deepEqual(entries.map((e) => e.deliveryId), ids);
  assert.equal(entries[0]!.eventType, "transaction.captured");
  assert.equal(entries[1]!.eventType, "transaction.voided");
  assert.equal(entries[0]!.createdAt, "2026-05-02T00:00:00.000Z");
  assert.deepEqual(entries[1]!.payload.data, { marker: "2026-05-03T00:00:00Z" });
});

test("capture writes an audit row and 404s for an endpoint the merchant does not own", async () => {
  const merchantId = await createMerchant();
  const otherMerchantId = await createMerchant();
  const adminUserId = await createAdminUser();
  const endpointId = await createEndpoint(merchantId);
  const foreignEndpointId = await createEndpoint(otherMerchantId);

  const created = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId,
    adminUserId,
    ...WINDOW,
  });
  assert.equal(created.deliveryCount, 0);

  const audit = await pool.query<{ action: string; target_id: string }>(
    `SELECT action, target_id FROM admin_audit_log WHERE admin_user_id = $1`,
    [adminUserId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.action, "webhook_delivery_archive_create");
  assert.equal(audit.rows[0]!.target_id, endpointId);

  await assert.rejects(
    createWebhookDeliveryArchive(pool, {
      merchantId,
      endpointId: foreignEndpointId,
      adminUserId,
      ...WINDOW,
    }),
    (err: unknown) => err instanceof NotFoundError && err.code === "webhook_endpoint_not_found",
  );
});

test("replays an archive against a different target endpoint, linking each row to its original", async () => {
  const merchantId = await createMerchant();
  const adminUserId = await createAdminUser();
  const sourceEndpointId = await createEndpoint(merchantId);
  const targetEndpointId = await createEndpoint(merchantId);

  const originalIds = [
    await insertDelivery(sourceEndpointId, { eventType: "transaction.captured", createdAt: "2026-05-02T00:00:00Z" }),
    await insertDelivery(sourceEndpointId, { eventType: "transaction.captured", createdAt: "2026-05-03T00:00:00Z" }),
  ];

  const created = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId: sourceEndpointId,
    adminUserId,
    ...WINDOW,
  });

  const replayed = await replayWebhookDeliveryArchive(pool, {
    merchantId,
    archiveId: created.archiveId,
    targetEndpointId,
    adminUserId,
  });
  assert.equal(replayed.replayedCount, 2);

  const rows = await pool.query<{ replay_of_delivery_id: string; endpoint_id: string; status: string }>(
    `SELECT replay_of_delivery_id, endpoint_id, status FROM webhook_deliveries
      WHERE endpoint_id = $1 ORDER BY created_at ASC`,
    [targetEndpointId],
  );
  assert.equal(rows.rows.length, 2);
  // Both rows are inserted in one transaction, so created_at ties (Postgres's
  // now() is transaction-start-stable) — compare as sets, not by read order.
  assert.deepEqual(rows.rows.map((r) => r.replay_of_delivery_id).sort(), [...originalIds].sort());
  assert.ok(rows.rows.every((r) => r.endpoint_id === targetEndpointId));
  assert.ok(rows.rows.every((r) => r.status === "pending"));
});

test("replay 404s on an archive/merchant mismatch and conflicts on a disabled target", async () => {
  const merchantId = await createMerchant();
  const otherMerchantId = await createMerchant();
  const adminUserId = await createAdminUser();
  const endpointId = await createEndpoint(merchantId);
  const disabledEndpointId = await createEndpoint(merchantId, "disabled");

  const created = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId,
    adminUserId,
    ...WINDOW,
  });

  await assert.rejects(
    replayWebhookDeliveryArchive(pool, {
      merchantId: otherMerchantId,
      archiveId: created.archiveId,
      targetEndpointId: endpointId,
      adminUserId,
    }),
    (err: unknown) => err instanceof NotFoundError && err.code === "webhook_delivery_archive_not_found",
  );

  await assert.rejects(
    replayWebhookDeliveryArchive(pool, {
      merchantId,
      archiveId: created.archiveId,
      targetEndpointId: disabledEndpointId,
      adminUserId,
    }),
    (err: unknown) => err instanceof ConflictError && err.code === "endpoint_disabled",
  );
});
