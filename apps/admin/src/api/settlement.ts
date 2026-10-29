import { request } from "./client.js";
import type { AnalyticsRebuildSummary, BalanceRebuildSummary, RunBatchSummary } from "../types.js";

/** `POST /v1/admin/settlement/run-batch`. `date` is a `YYYY-MM-DD`
 *  business date; omitting `merchantId` runs every eligible merchant. */
export function runBatch(input: { date: string; merchantId?: string }): Promise<RunBatchSummary> {
  return request("/v1/admin/settlement/run-batch", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `POST /v1/admin/balances/rebuild`. No body.
 *
 * Refreshes cached balances for every merchant. Non-destructive — it only
 * rewrites the cache — but it's the widest-blast-radius button in this
 * console, so the UI asks for confirmation before calling it.
 */
export function rebuildBalances(): Promise<BalanceRebuildSummary> {
  return request("/v1/admin/balances/rebuild", { method: "POST" });
}

/**
 * `POST /v1/admin/reporting/rebuild`. No body.
 *
 * Empties the analytics read model (daily volumes, payout trends) and has
 * apps/reporting's worker replay the outbox into it from the start.
 * Platform-wide like the balance rebuild above, so the UI asks before
 * calling it.
 */
export function rebuildAnalytics(): Promise<AnalyticsRebuildSummary> {
  return request("/v1/admin/reporting/rebuild", { method: "POST" });
}
