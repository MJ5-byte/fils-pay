-- refund_merchant_summary (0072) summed t.captured_fils once per *refund row*.
-- A payment refunded in two parts on the same day therefore reported its
-- original capture twice: 10.000 BD captured, two 2.000 BD refunds showed
-- original_captured_fils = 20.000 BD, so "refunded vs captured" in the
-- dashboard and reconciliation was wrong for every partial refund.
-- Aggregate per transaction first, then roll up, so each payment's capture is
-- counted once per merchant-day.

DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH per_transaction AS (
    SELECT
        r.merchant_id,
        date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
        r.transaction_id,
        COUNT(*)                 AS refund_count,
        SUM(r.amount_fils)       AS refunded_fils,
        SUM(r.fee_reversed_fils) AS fee_reversed_fils
    FROM refunds r
    WHERE r.status = 'succeeded'
    GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain'), r.transaction_id
)
SELECT
    p.merchant_id,
    p.business_date,
    SUM(p.refund_count)::bigint  AS refund_count,
    SUM(p.refunded_fils)         AS total_refunded_fils,
    SUM(p.fee_reversed_fils)     AS total_fee_reversed_fils,
    SUM(t.captured_fils)         AS original_captured_fils
FROM per_transaction p
JOIN transactions t ON t.id = p.transaction_id
GROUP BY p.merchant_id, p.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
