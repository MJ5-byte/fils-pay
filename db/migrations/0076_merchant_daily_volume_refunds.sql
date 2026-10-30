-- FP-212: refunds in the merchant daily volume rollup. The reporting consumer
-- adds one row per refund.succeeded event, and the admin rebuild recomputes
-- the same figures from transaction_events ('refunded' / 'refund_partial').
-- Bucketed by the Asia/Bahrain business day, like the capture columns.

ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;
