# Bug 22 — Admin "Recalculate cached balances" does not read the ledger (FP-203)

**Severity:** Critical · **Area:** Settlement / admin · **Clue:** Support FP-203; Finance — *"Alpha Retail's balance went from 135K to 7K. Yousif had to run the CLI rebuild."*; HANDOVER — there should be no button that reads anything else

## Where
- HTTP `/internal/rebuild-balances` → `RefreshBalanceCache` → view `merchant_payable_position`
- `db/migrations/0054_views.sql:3-8` — `SUM(scheme_export_lines.amount_fils)` grouped by merchant (lifetime truncated **gross**, all batch statuses, no fees/payouts/refunds/credits)
- CLI `settlement rebuild-balances` walks `ledger_entries` (`rebuild.go`)

## What's wrong
The console button and the CLI write the same cache column from different sources. ADR-0004 documents this split as a "decision"; HANDOVER and ARCHITECTURE say the cache is rebuilt from the ledger. The 135K → 7K incident is exactly "lifetime scheme gross of one quiet merchant vs a ledger that includes payouts."

## Why
A "faster query path" was wired to the button so it would fit a 30s HTTP timeout. It is not a balance.

## What it breaks
One click destroys every merchant's cached payable. Finance cannot trust the dashboard until someone runs the CLI.

## Smallest fix
Point the HTTP handler at `ledger.RebuildAllBalances` (same as the CLI). If it is too slow, make it a job, do not change the source.
