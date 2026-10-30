-- FP-212 / FP-300: refunds in the reporting read model.
--
-- 1. merchant_daily_volume had no refund columns, so the refund rollup in
--    apps/reporting could never have run.
-- 2. refund_merchant_summary joined transactions on t.id = r.id (a refund id
--    compared with a transaction id), so it was always empty. Recreated with
--    the right join; original_captured_fils counts each transaction once.

ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

DROP MATERIALIZED VIEW refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    merchant_id,
    business_date,
    SUM(refund_count)        AS refund_count,
    SUM(refunded_fils)       AS total_refunded_fils,
    SUM(fee_reversed_fils)   AS total_fee_reversed_fils,
    SUM(captured_fils)       AS original_captured_fils
FROM (
    SELECT
        r.merchant_id,
        date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
        r.transaction_id,
        COUNT(*)                 AS refund_count,
        SUM(r.amount_fils)       AS refunded_fils,
        SUM(r.fee_reversed_fils) AS fee_reversed_fils,
        MAX(t.captured_fils)     AS captured_fils
    FROM refunds r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE r.status = 'succeeded'
    GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain'), r.transaction_id
) per_transaction
GROUP BY merchant_id, business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
