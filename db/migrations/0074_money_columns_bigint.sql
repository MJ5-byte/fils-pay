-- B10: widen the two lifetime running totals from 32-bit / float storage to
-- BIGINT, because both accumulate integer fils and both lose exactness
-- today:
--
--   * merchants.lifetime_net_payout_monitoring_estimate is REAL (float32,
--     0040), which holds exact integers only up to 2^24 fils (~16.7K BD) —
--     past that every payout delta rounds and the estimate drifts
--     monotonically from the batch sums it mirrors.
--   * platform_stats.total_processed_fils is INTEGER (0049), whose 2^31-1
--     ceiling sits just above the volume-tier threshold (2,000,000,000) —
--     the counter that decides the tier silently saturates instead of
--     crossing it.
--
-- No backfill is needed: both were seeded at zero and only ever summed
-- forward; widening preserves every existing value exactly. All Go
-- accumulators/scans for these columns now use int64
-- (internal/settlement/payout_estimate.go, platform_volume.go).

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT;

ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
