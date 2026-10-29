import type { PoolClient } from "pg";
import { runRebuild } from "../../../reporting/src/cli/rebuild.js";
import { loadConfig as loadReportingConfig } from "../../../reporting/src/config.js";
import { createPool as createReportingPool } from "../../../reporting/src/db/pool.js";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/**
 * Rebuilds the analytics rollups by delegating to apps/reporting's
 * canonical runRebuild — the same TRUNCATE + full outbox-replay path the
 * `reporting rebuild` CLI uses. Previously this was a second, independent
 * TRUNCATE + direct-repopulate implementation (BUG5): it re-aggregated
 * transaction_events and settlement_batches from source, which drifts from
 * what the consumer produces whenever the outbox and source tables
 * disagree, and the two rebuilders returned different rollup data.
 *
 * The caller (routes/admin.ts) holds this inside a transaction whose only
 * other work is the audit-log insert, so a short-lived one-off pool for
 * runRebuild's own transactions is fine; the final row counts are read
 * back through the caller's client for the audit metadata.
 */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  const config = loadReportingConfig(process.env);
  const pool = createReportingPool(config);
  try {
    await runRebuild(pool, config);
  } finally {
    await pool.end();
  }

  const [volumeResult, trendResult] = await Promise.all([
    client.query<{ count: string }>(`SELECT count(*) FROM merchant_daily_volume`),
    client.query<{ count: string }>(`SELECT count(*) FROM merchant_payout_trends`),
  ]);
  return {
    volumeRows: Number(volumeResult.rows[0]?.count ?? 0),
    trendRows: Number(trendResult.rows[0]?.count ?? 0),
  };
}
