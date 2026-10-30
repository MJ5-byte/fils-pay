-- Additional suspense accounts for future reconciliation lanes.
--
-- chart_of_accounts (0007) is keyed on id with kind restricted to
-- ('asset','liability','revenue'); it has no code, account_type or
-- description column and no 'suspense' kind. Both of these are debit-side
-- holding accounts, so they take kind 'asset', the same treatment 0007
-- gives its one existing suspense account, scheme_rounding_residue
-- (see ADR-0002). The descriptive text moves into the name, since the
-- table has no description column.
INSERT INTO chart_of_accounts (id, name, kind) VALUES
    ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
    ('chargeback_suspense', 'Chargeback suspense (pending acquirer confirmation)', 'asset')
ON CONFLICT (id) DO NOTHING;
