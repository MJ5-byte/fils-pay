import type { Pool } from "pg";
import type { ReportingConfig } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { resetCursor } from "../consumer/cursor.js";
import { runConsumerPass, CONSUMER_NAME } from "../consumer/runConsumerPass.js";

interface RollupCounts {
  volumeRows: number;
  trendRows: number;
}

/**
 * Counts are read outside the rebuild transaction and are informational.
 */
async function getRollupCounts(pool: Pool): Promise<RollupCounts> {
  const [volumeResult, trendResult] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*) FROM merchant_daily_volume`),
    pool.query<{ count: string }>(`SELECT count(*) FROM merchant_payout_trends`),
  ]);
  return {
    volumeRows: Number(volumeResult.rows[0]?.count ?? 0),
    trendRows: Number(trendResult.rows[0]?.count ?? 0),
  };
}

/**
 * `reporting rebuild` — CLI-only recovery tool. Truncates
 * merchant_daily_volume and merchant_payout_trends, resets this consumer's watermark to 0, and
 * replays the ENTIRE outbox history for the event types this worker
 * consumes through the exact same runConsumerPass/applyEvent path used for
 * live consumption — one code path, no second implementation that could
 * drift from what the daemon does every day.
 *
 * Prints a before/after row count per rollup table, same operator-facing
 * transparency apps/settlement's `rebuild-balances` already established.
 *
 * Never invoked automatically (not on a schedule, not on worker startup)
 * and not exposed over HTTP — referenced only from cli/index.ts's
 * `rebuild` subcommand dispatch and this file's own test.
 *
 * — M?: the read model only ever gets built one way: by replaying the
 * outbox through the same code the worker runs. anything that fills these
 * tables from somewhere else is a second implementation, and it will drift.
 */
export async function runRebuild(pool: Pool, config: ReportingConfig): Promise<void> {
  const before = await getRollupCounts(pool);
  console.log(
    `[reporting/rebuild] before: merchant_daily_volume=${before.volumeRows} rows, merchant_payout_trends=${before.trendRows} rows`,
  );

  // FH: truncate + reset in one tx, replay outside it -- a live worker can race the replay? (MK: worker is stopped during rebuild per RUNBOOK)
  await withTransaction(pool, async (client) => {
    await client.query(`TRUNCATE merchant_daily_volume`);
    await client.query(`TRUNCATE merchant_payout_trends`);
    await resetCursor(client, CONSUMER_NAME);
  });

  let totalProcessed = 0;
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, config);
    totalProcessed += processedCount;
    if (processedCount === 0) break;
  }

  // TODO: diff against apps/api admin/reportingRebuild.ts output (YA 2026-02)
  const after = await getRollupCounts(pool);
  console.log(
    `[reporting/rebuild] after:  merchant_daily_volume=${after.volumeRows} rows, merchant_payout_trends=${after.trendRows} rows`,
  );
  console.log(`[reporting/rebuild] replayed ${totalProcessed} event(s) total`);
}
