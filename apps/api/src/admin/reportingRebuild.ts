import type { PoolClient } from "pg";
import { ConflictError } from "../lib/errors.js";

/** apps/reporting's CONSUMER_NAME, the row its worker keeps its watermark in. */
const REPORTING_CONSUMER_NAME = "reporting";

/** Must match the channel the outbox trigger notifies on (apps/reporting's listener.ts). */
const OUTBOX_NOTIFY_CHANNEL = "outbox_events_channel";

/**
 * Empties the two rollup tables (merchant_daily_volume, merchant_payout_trends)
 * and rewinds the reporting consumer's cursor to 0 in the caller's transaction,
 * the same step `reporting rebuild` takes. The reporting worker then replays
 * the whole outbox through its own consumer pass, so the rollups are only ever
 * filled one way and every event is applied exactly once.
 *
 * Filling the rollups here from source tables instead, as this used to, counts
 * every event the worker had not reached yet, and the worker then applied
 * those events again on top.
 */
export async function resetAnalyticsRollups(client: PoolClient): Promise<void> {
  // A queued TRUNCATE blocks every dashboard read that arrives after it, so
  // give up on a long consumer pass or a slow read rather than wait it out.
  await client.query(`SET LOCAL lock_timeout = '5s'`);
  try {
    // Cursor row first: a consumer pass locks it before it writes the
    // rollups, so taking the locks in the same order waits for that pass to
    // commit instead of deadlocking with it. Same upsert as apps/reporting's
    // resetCursor (consumer/cursor.ts).
    await client.query(
      `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
       VALUES ($1, 0, now())
       ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, updated_at = now()`,
      [REPORTING_CONSUMER_NAME],
    );
    await client.query(`TRUNCATE merchant_daily_volume, merchant_payout_trends`);
  } catch (err) {
    if ((err as { code?: unknown }).code === "55P03") {
      throw new ConflictError(
        "reporting_rebuild_busy",
        "Analytics are being updated right now; try the rebuild again in a moment.",
      );
    }
    throw err;
  }
  // Delivered on commit; wakes the worker now rather than at its next poll.
  await client.query(`NOTIFY ${OUTBOX_NOTIFY_CHANNEL}`);
}
