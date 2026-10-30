# BUG-011 — Admin Recalculate Cached Balances Reads Scheme Gross Instead of Ledger

## 1. Summary

The console button and the CLI write the same cache column from different sources.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Admin console and controls
- Affected Component: apps/api/src/routes/adminBalances.ts, db/migrations/0054_views.sql
- Reachability: Reachable via Admin Console button
- Original Contributors / Sources: Support FP-203, ADR-0004, HANDOVER

## 3. Root Cause

A "faster query path" was wired to the button so it would fit a 30s HTTP timeout. It is not a balance.

## 4. Affected Files and Functions

- HTTP `/internal/rebuild-balances` → `RefreshBalanceCache` → view `merchant_payable_position`
- `db/migrations/0054_views.sql:3-8` — `SUM(scheme_export_lines.amount_fils)` grouped by merchant (lifetime truncated **gross**, all batch statuses, no fees/payouts/refunds/credits)
- CLI `settlement rebuild-balances` walks `ledger_entries` (`rebuild.go`)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The console button and the CLI write the same cache column from different sources. ADR-0004 documents this split as a "decision"; HANDOVER and ARCHITECTURE say the cache is rebuilt from the ledger. The 135K → 7K incident is exactly "lifetime scheme gross of one quiet merchant vs a ledger that includes payouts."

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- HTTP `/internal/rebuild-balances` → `RefreshBalanceCache` → view `merchant_payable_position`
- `db/migrations/0054_views.sql:3-8` — `SUM(scheme_export_lines.amount_fils)` grouped by merchant (lifetime truncated **gross**, all batch statuses, no fees/payouts/refunds/credits)
- CLI `settlement rebuild-balances` walks `ledger_entries` (`rebuild.go`)

Technical details:
The console button and the CLI write the same cache column from different sources. ADR-0004 documents this split as a "decision"; HANDOVER and ARCHITECTURE say the cache is rebuilt from the ledger. The 135K → 7K incident is exactly "lifetime scheme gross of one quiet merchant vs a ledger that includes payouts."

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

One click destroys every merchant's cached payable. Finance cannot trust the dashboard until someone runs the CLI.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support FP-203, ADR-0004, HANDOVER. Legacy file: `bug-22-recalculate-balances-wrong-source.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Point the HTTP handler at `ledger.RebuildAllBalances` (same as the CLI). If it is too slow, make it a job, do not change the source.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-22-recalculate-balances-wrong-source.md`

## 17. Evidence References

`apps/api/src/routes/adminBalances.ts, db/migrations/0054_views.sql`, `bug-22-recalculate-balances-wrong-source.md`
