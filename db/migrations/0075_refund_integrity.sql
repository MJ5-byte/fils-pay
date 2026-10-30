-- 1. refund_merchant_summary (0072) joined transactions on t.id = r.id, a
--    refund id against a transaction id, so it matched nothing and every
--    summary row was empty. It also summed captured_fils once per refund, so
--    a transaction refunded in parts was counted several times. Recreated
--    with the right join and each transaction counted once per day.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH daily AS (
    SELECT r.merchant_id,
           date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           r.transaction_id,
           COUNT(*)                 AS refund_count,
           SUM(r.amount_fils)       AS refunded_fils,
           SUM(r.fee_reversed_fils) AS fee_reversed_fils
      FROM refunds r
     WHERE r.status = 'succeeded'
     GROUP BY 1, 2, 3
)
SELECT d.merchant_id,
       d.business_date,
       SUM(d.refund_count)      AS refund_count,
       SUM(d.refunded_fils)     AS total_refunded_fils,
       SUM(d.fee_reversed_fils) AS total_fee_reversed_fils,
       SUM(t.captured_fils)     AS original_captured_fils
  FROM daily d
  JOIN transactions t ON t.id = d.transaction_id
 GROUP BY d.merchant_id, d.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);

-- 2. Nothing in the schema stopped refunded_fils exceeding captured_fils;
--    only application code did, and that code allowed it until FP-212's
--    fixes. NOT VALID: enforced for every new write without failing on any
--    historical row that already violates it (those need finance review).
ALTER TABLE transactions
    ADD CONSTRAINT transactions_refunded_le_captured CHECK (refunded_fils <= captured_fils) NOT VALID;
