import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRow } from "./replay.js";

export interface ArchivedDeliveryEntry {
  deliveryId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Same per-call cap as replayBatch.ts and the dispatcher: one request never
 *  holds a transaction open for an unbounded number of rows. */
const MAX_BATCH_SIZE = 500;

export interface CreateArchiveResult {
  archiveId: string;
  deliveryCount: number;
  /** Delivery id to pass as `after` for the next archive; null when the range is fully covered. */
  nextCursor: string | null;
}

/**
 * Snapshots every delivery for one endpoint in [from, to) into a single
 * retained row, ahead of a URL rotation or the endpoint being disabled. At
 * most MAX_BATCH_SIZE deliveries per archive; a non-null `nextCursor` says the
 * range is not yet fully covered, and the caller creates the next archive with
 * `after` set to it. Nothing is dropped silently.
 */
export async function createWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; endpointId: string; adminUserId: string; from: Date; to: Date; after?: string },
): Promise<CreateArchiveResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.endpointId, input.merchantId],
    );
    if (!endpoint.rows[0]) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }

    if (input.after) {
      const cursor = await client.query(
        `SELECT 1 FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2`,
        [input.after, input.endpointId],
      );
      if (!cursor.rows[0]) {
        throw new NotFoundError("webhook_delivery_not_found");
      }
    }

    const rows = await client.query<{
      id: string;
      outbox_event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, outbox_event_id, event_type, payload, created_at
         FROM webhook_deliveries
        WHERE endpoint_id = $1 AND created_at >= $2 AND created_at < $3
          AND ($4::uuid IS NULL OR (created_at, id) > (
                SELECT created_at, id FROM webhook_deliveries WHERE id = $4 AND endpoint_id = $1))
        ORDER BY created_at ASC, id ASC
        LIMIT $5`,
      [input.endpointId, input.from, input.to, input.after ?? null, MAX_BATCH_SIZE + 1],
    );
    const hasMore = rows.rows.length > MAX_BATCH_SIZE;
    const page = rows.rows.slice(0, MAX_BATCH_SIZE);

    const entries: ArchivedDeliveryEntry[] = page.map((r) => ({
      deliveryId: r.id,
      outboxEventId: r.outbox_event_id,
      eventType: r.event_type,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    }));

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.endpointId,
        input.merchantId,
        input.adminUserId,
        input.from,
        input.to,
        entries.length,
        JSON.stringify(entries),
      ],
    );

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount: entries.length },
    });

    return {
      archiveId: inserted.rows[0]!.id,
      deliveryCount: entries.length,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

/**
 * Bulk-replays deliveries captured in a previously created archive — used to
 * backfill a newly registered replacement endpoint with a merchant's delivery
 * history after a URL rotation. Replays one page of up to MAX_BATCH_SIZE
 * entries from `offset`; a non-null `nextOffset` is where the caller continues.
 */
export async function pruneExpiredArchives(
  pool: Pool,
  retentionDays: number,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await pool.query(
    `DELETE FROM webhook_delivery_archives
      WHERE created_at < $1
        AND created_by_admin_user_id IS NOT NULL
    RETURNING id`,
    [cutoff],
  );
  return { deletedCount: result.rowCount ?? 0 };
}

export async function replayWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; archiveId: string; targetEndpointId: string; adminUserId: string; offset?: number },
): Promise<{ replayedCount: number; nextOffset: number | null }> {
  return withTransaction(pool, async (client) => {
    const archiveResult = await client.query<{ archive_payload: string }>(
      `SELECT archive_payload FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
      [input.archiveId, input.merchantId],
    );
    const archiveRow = archiveResult.rows[0];
    if (!archiveRow) {
      throw new NotFoundError("webhook_delivery_archive_not_found");
    }

    const targetEndpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.targetEndpointId, input.merchantId],
    );
    const targetRow = targetEndpoint.rows[0];
    if (!targetRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    const entries = JSON.parse(archiveRow.archive_payload) as ArchivedDeliveryEntry[];

    const offset = input.offset ?? 0;
    const slice = entries.slice(offset, offset + MAX_BATCH_SIZE);
    const nextOffset = offset + slice.length < entries.length ? offset + slice.length : null;

    let replayedCount = 0;
    for (const entry of slice) {
      await insertReplayDeliveryRow(client, {
        id: entry.deliveryId,
        endpointId: input.targetEndpointId,
        outboxEventId: entry.outboxEventId,
        eventType: entry.eventType,
        payload: entry.payload,
      });
      replayedCount++;
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_replay",
      targetType: "webhook_endpoint",
      targetId: input.targetEndpointId,
      metadata: { merchantId: input.merchantId, archiveId: input.archiveId, offset, replayedCount },
    });

    return { replayedCount, nextOffset };
  });
}
