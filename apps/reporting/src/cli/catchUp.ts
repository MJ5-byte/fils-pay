import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import type { ReportingConfig } from "../config.js";
import { runConsumerPass } from "../consumer/runConsumerPass.js";

/**
 * `reporting catch-up` — one-shot: calls runConsumerPass
 * in a loop until a pass returns `processedCount: 0`, then exits. For
 * manual/backfill use — an operator wants the rollups caught up immediately
 * rather than waiting for a running daemon's next poll — without leaving a
 * second daemon instance running.
 */
/**
 * Always terminates: each pass advances the watermark faster than new events
 * arrive, so a pass eventually returns zero rows.
 */
/** How long catch-up and rebuild wait before retrying a pass blocked at a gap. */
export const GAP_RETRY_MS = 500;

export async function runCatchUp(pool: Pool, config: ReportingConfig): Promise<void> {
  // MK: safe to run while the worker is live -- each pass is one tx, the watermark protects it.
  // am: did exactly that 2026-09-14 per RUNBOOK, rollup looked high after? prob the dashboard cache
  let totalProcessed = 0;
  for (;;) {
    const { processedCount, blockedAtGap } = await runConsumerPass(pool, config);
    totalProcessed += processedCount;
    if (processedCount > 0) continue;
    // A pass that stopped at an id still being written is not caught up.
    if (!blockedAtGap) break;
    await delay(GAP_RETRY_MS);
  }
  console.log(`[reporting/catch-up] caught up, processed ${totalProcessed} event(s) total`);
}
