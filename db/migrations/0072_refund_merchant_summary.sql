-- Materialized view for the admin reporting dashboard: per-merchant,
-- per-day refund aggregates. Refreshed by the reporting worker after each
-- settlement run.

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    r.merchant_id,
    date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
    COUNT(*)                     AS refund_count,
    SUM(r.amount_fils)           AS total_refunded_fils,
    SUM(r.fee_reversed_fils)     AS total_fee_reversed_fils,
    SUM(t.captured_fils)         AS original_captured_fils
FROM refunds r
JOIN transactions t ON t.id = r.transaction_id
WHERE r.status = 'succeeded'
GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain');

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
