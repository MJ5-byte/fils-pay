-- merchants.lifetime_net_payout_monitoring_estimate (0040) was REAL, a 32-bit
-- float that holds every integer only up to 2^24 fils (about 16,777 BD).
-- Past that, each payout added to the running total rounds, so the figure
-- drifts for high-volume merchants. ADR-0001 keeps money in integer fils.
--
-- Additive and data-preserving: a type change, no column or row dropped.
-- Existing values are rounded to whole fils (they were already approximate).
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate DROP DEFAULT,
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
        USING round(lifetime_net_payout_monitoring_estimate)::bigint,
    ALTER COLUMN lifetime_net_payout_monitoring_estimate SET DEFAULT 0;
