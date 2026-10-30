-- Refund rollup columns for merchant_daily_volume, filled by the reporting
-- consumer from refund.succeeded events. Additive only.
ALTER TABLE merchant_daily_volume
    ADD COLUMN IF NOT EXISTS refund_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refund_gross_fils BIGINT NOT NULL DEFAULT 0;
