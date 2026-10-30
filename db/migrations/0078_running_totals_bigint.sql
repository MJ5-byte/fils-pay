-- Two running totals were stored too narrow for the money they count
-- (ADR-0001: whole fils, integers only).
--
-- merchants.lifetime_net_payout_monitoring_estimate was REAL (float4): exact
-- only up to 2^24 = 16,777,216 fils (~16,777 BD). Past that each addition
-- rounds, so the estimate drifted for exactly the high-volume merchants ops
-- watches ("lifetime payout estimate drifts", finance memo).
--
-- platform_stats.total_processed_fils was INTEGER (int4, max 2,147,483,647)
-- while the volume-tier threshold is 2,000,000,000. The Go writer used int32,
-- so crossing ~2.1M BD wrapped the total negative and silently switched the
-- 15 bps volume discount off for every merchant. (INTEGER is 32-bit in
-- Postgres on every build.)

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
