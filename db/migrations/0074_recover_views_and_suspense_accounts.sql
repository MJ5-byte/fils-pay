-- Recovery migration for 0054 and 0055.
--
-- 0054_views.sql and 0055_chart_of_accounts_suspense.sql were corrected in
-- place because their original bodies referenced schema that never existed
-- and aborted the migrate run before any later migration could execute, so
-- a forward migration alone could not reach them on a fresh database.
--
-- The in-place fix heals a fresh database, but any database that already
-- marked 0054/0055 applied (the local baseline workaround) skips them and so
-- never gets their objects: the three views and the two suspense accounts are
-- missing, and admin balance rebuild (merchant_payable_position in
-- apps/settlement/internal/ledger/refresh.go) fails there.
--
-- This migration repeats the corrected statements. Every statement is
-- idempotent: CREATE OR REPLACE VIEW and INSERT ... ON CONFLICT DO NOTHING.
-- On a fresh database it is a no-op (0054/0055 already created the objects
-- identically). On a marked database it creates the missing objects. It is
-- strictly additive and drops or alters nothing.

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT sb.merchant_id,
       COALESCE(SUM(sel.amount_fils), 0) AS payable_fils
  FROM scheme_export_lines sel
  JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
 GROUP BY sb.merchant_id;

CREATE OR REPLACE VIEW v_unbatched_capture_events AS
SELECT te.id AS event_id,
       te.transaction_id,
       te.event_type,
       te.amount_fils,
       te.created_at,
       t.merchant_id
  FROM transaction_events te
  JOIN transactions t ON t.id = te.transaction_id
 WHERE te.event_type IN ('captured', 'partially_captured')
   AND te.settlement_batch_id IS NULL;

CREATE OR REPLACE VIEW v_active_api_keys AS
SELECT ak.id,
       ak.merchant_id,
       ak.key_prefix,
       ak.created_at,
       ak.label
  FROM api_keys ak
 WHERE ak.revoked_at IS NULL;

INSERT INTO chart_of_accounts (id, name, kind) VALUES
    ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
    ('chargeback_suspense', 'Chargeback suspense (pending acquirer confirmation)', 'asset')
ON CONFLICT (id) DO NOTHING;
