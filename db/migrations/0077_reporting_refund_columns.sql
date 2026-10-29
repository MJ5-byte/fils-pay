-- The reporting consumer's refund rollup: merchant_daily_volume gains the
-- refund_count / refund_gross_fils column pair so refund.succeeded outbox
-- events can be rolled into the same per-(merchant, Asia/Bahrain day) row
-- that captured/voided already use. Without these columns the dormant
-- applyDailySummaryRollup helper would fail with
-- `column "refund_count" does not exist` the moment refund wiring landed.
--
-- Counts and fils are BIGINT deliberately (lane spec): they accumulate
-- exact integer fils and match the 0074 money-column widening, unlike the
-- older INTEGER count columns this table predates.

ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT NOT NULL DEFAULT 0;
