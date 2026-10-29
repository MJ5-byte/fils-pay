-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils
-- = 2,147,483.647 BD), just above the 2,000,000,000 volume-tier threshold,
-- so the counter overflowed shortly after crossing it.
-- merchants.lifetime_net_payout_monitoring_estimate was REAL (24-bit
-- mantissa), which drops whole fils once a merchant passes ~16,777 BD.
-- Both become BIGINT integer fils like every other money column (ADR-0001).

ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
