import type { Pool, PoolClient } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

// am: refund.succeeded not here yet. when refunds ship just add it to the list
export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "settlement.paid",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number; blockedAtGap: boolean }> {
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    let maxId = cursor.lastProcessedId;
    let processedCount = 0;
    let blockedAtGap = false;
    // Each read is its own statement, so under READ COMMITTED it sees every
    // commit made before it; a gap that settles mid-pass is read once more
    // before it is skipped, in case its writer committed in between.
    for (let rereadAfterSettledGap = true; rereadAfterSettledGap; ) {
      rereadAfterSettledGap = false;
      // Every event type, not just ours, so a missing id is a real gap rather
      // than another consumer's event.
      const eventsResult = await client.query<OutboxEventRow>(
        `SELECT id, event_type, aggregate_id, payload, created_at
           FROM outbox_events
          WHERE id > $1
          ORDER BY id ASC
          LIMIT $2`,
        [maxId.toString(), config.consumerBatchLimit - processedCount],
      );

      for (const row of eventsResult.rows) {
        const rowId = BigInt(row.id);
        if (rowId !== maxId + 1n) {
          const gap = await checkGap(client, maxId + 1n);
          if (gap === "open") {
            blockedAtGap = true;
            break;
          }
          if (gap === "settled now") {
            rereadAfterSettledGap = true;
            break;
          }
        }
        if (REPORTING_EVENT_TYPES.includes(row.event_type as EventType)) {
          await applyEvent(client, row);
        }
        maxId = rowId;
        processedCount += 1;
      }
    }

    if (maxId > cursor.lastProcessedId) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }
    for (const gapId of gaps.keys()) {
      if (gapId <= maxId) gaps.delete(gapId);
    }

    return { processedCount, blockedAtGap };
  });
}

/**
 * Outbox ids come from a sequence, but writers commit in their own order:
 * CloseBatch inserts its batch_closed event and keeps its transaction open
 * while the API commits later ids. A missing id is either still being written
 * or gone for good (a rolled-back insert).
 *
 * Every insert takes a RowExclusiveLock on outbox_events before it draws its
 * id and holds it until its transaction ends. So whoever holds a missing id
 * either still holds that lock when this check runs (after the read that
 * found the gap) or has already ended. The gap waits on exactly the
 * transactions holding the lock when it was first seen; once all of them
 * have ended it is final, and the outbox is read once more before skipping
 * it. Kept in memory per process: a restart only waits again.
 */
const gaps = new Map<bigint, Set<string> | "final">();

async function checkGap(client: PoolClient, gapId: bigint): Promise<"open" | "settled now" | "final"> {
  const state = gaps.get(gapId);
  if (state === "final") return "final";

  const writersResult = await client.query<{ virtualtransaction: string }>(
    `SELECT DISTINCT virtualtransaction
       FROM pg_locks
      WHERE locktype = 'relation'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = 'outbox_events'::regclass
        AND mode = 'RowExclusiveLock'
        AND pid IS DISTINCT FROM pg_backend_pid()`,
  );
  const writers = new Set(writersResult.rows.map((r) => r.virtualtransaction));
  const waitingOn = state ? new Set([...state].filter((vxid) => writers.has(vxid))) : writers;

  if (waitingOn.size > 0) {
    gaps.set(gapId, waitingOn);
    return "open";
  }
  gaps.set(gapId, "final");
  return "settled now";
}
