-- Additional suspense accounts for future reconciliation lanes.
--
-- FIX: the original INSERT used columns (code, account_type, description) that
-- chart_of_accounts does not have, and kind 'suspense', which its CHECK
-- constraint (0007) rejects. The real columns are (id, name, kind) and kind is
-- one of asset/liability/revenue. Suspense accounts are modelled as 'asset',
-- the same as scheme_rounding_residue in 0007.
INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
  ('chargeback_suspense',    'Chargeback suspense',               'asset')
ON CONFLICT (id) DO NOTHING;
