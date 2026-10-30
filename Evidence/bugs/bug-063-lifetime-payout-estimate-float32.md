# BUG-063 — Merchant Lifetime Payout Monitoring Accumulates in Float32 Column

## 1. Summary

Payouts are added as `float32` / REAL.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/settlement/payout_estimate.go, db/migrations/0040_*.sql
- Reachability: Reachable as high-volume merchants accumulate settlement volume
- Original Contributors / Sources: Group chat clue on lifetime payout estimate drift

## 3. Root Cause

Same "BD is only 2 decimals" decoy as Bug 20.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/payout_estimate.go`
- `db/migrations/0040_merchants_lifetime_payout_monitoring_estimate.sql` — REAL column

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Payouts are added as `float32` / REAL. Past ~2^24 fils the stored total cannot represent every fils.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/payout_estimate.go`
- `db/migrations/0040_merchants_lifetime_payout_monitoring_estimate.sql` — REAL column

Technical details:
Payouts are added as `float32` / REAL. Past ~2^24 fils the stored total cannot represent every fils.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Ops dashboards for high-volume merchants slowly diverge from the ledger. Not itself a payout, but it is what finance quotes.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Group chat clue on lifetime payout estimate drift. Legacy file: `bug-29-lifetime-payout-estimate-float32.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`BIGINT` column, integer sum of `net_payout_fils`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-29-lifetime-payout-estimate-float32.md`

## 17. Evidence References

`apps/settlement/internal/settlement/payout_estimate.go, db/migrations/0040_*.sql`, `bug-29-lifetime-payout-estimate-float32.md`
