-- Convenience views used by the API and admin dashboard.

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT sb.merchant_id,
       COALESCE(SUM(sel.amount_fils), 0) AS payable_fils
  FROM scheme_export_lines sel
  JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
 GROUP BY sb.merchant_id;

-- v_unbatched_capture_events was dropped from this migration: it referenced
-- settlement_batch_events, a relation no migration creates (abandoned PR).

CREATE OR REPLACE VIEW v_active_api_keys AS
SELECT ak.id,
       ak.merchant_id,
       ak.key_prefix,
       ak.created_at,
       ak.label
  FROM api_keys ak
 WHERE ak.revoked_at IS NULL;
