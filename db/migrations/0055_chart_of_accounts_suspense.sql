-- Additional suspense accounts for future reconciliation lanes.
-- chart_of_accounts (0007) is keyed by id with a kind CHECK of
-- asset/liability/revenue; suspense accounts are modelled as assets, like
-- scheme_rounding_residue.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference (suspense)', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
