# BUG-035 — MDR Recalculation Rewrites Batches That Are Already Paid Out

## 1. Summary

Paid batch totals are mutable.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/settlement/recalculate_mdr.go
- Reachability: Reachable via MDR recalculation command
- Original Contributors / Sources: Finance clue 'MDR recalculation changed paid batches'

## 3. Root Cause

`<> 'open'` was used instead of `= 'closed'` (or "open only"). Paid rows are not frozen.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/recalculate_mdr.go:63-112` — selects `status <> 'open'` (includes **paid** / **closed**), then `UPDATE settlement_batches SET fee_fils, net_payout_fils`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Paid batch totals are mutable. Settlement team claimed it only touches open batches; the predicate is the opposite of open.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/recalculate_mdr.go:63-112` — selects `status <> 'open'` (includes **paid** / **closed**), then `UPDATE settlement_batches SET fee_fils, net_payout_fils`

Technical details:
Paid batch totals are mutable. Settlement team claimed it only touches open batches; the predicate is the opposite of open.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Historical payouts no longer match what was actually disbursed. Reports and scheme vs ledger reconcilations rewrite themselves after the fact.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue 'MDR recalculation changed paid batches'. Legacy file: `bug-24-mdr-recalc-rewrites-paid-batches.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Restrict to `status = 'closed'` (unpaid), or insert an adjustment batch and never UPDATE a paid row.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-24-mdr-recalc-rewrites-paid-batches.md`

## 17. Evidence References

`apps/settlement/internal/settlement/recalculate_mdr.go`, `bug-24-mdr-recalc-rewrites-paid-batches.md`
