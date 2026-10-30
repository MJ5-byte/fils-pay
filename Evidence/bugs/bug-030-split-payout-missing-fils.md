# BUG-030 — Split Payouts Drop Fractional Fils Due to Independent Banker Rounding

## 1. Summary

Bankers rounding per child does not conserve the total.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/settlement/internal/splits/allocate.go
- Reachability: Reachable during split batch allocation
- Original Contributors / Sources: Finance clue, handwritten note 'splits a few fils short', ADR-0001

## 3. Root Cause

Per-weight rate application instead of largest-remainder allocation. ADR-0001 requires `allocateRemainder` so shares sum to the exact total.

## 4. Affected Files and Functions

- `apps/settlement/internal/splits/allocate.go:90-138` — each child gets independent `ApplyRateFils(netPayout, weightBps)`
- `packages/money` `allocateRemainder` exists and is unused from Go
- `apps/settlement/internal/splits/shares.go` exists and is not used in `PayoutSplitBatch`
- Zero shares are skipped (`AllocatedFils <= 0`) so remainder is dropped

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Bankers rounding per child does not conserve the total. The parent cache is debited by `totalAllocated`, not `netPayout`. The leftover fils vanish from the ledger.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/splits/allocate.go:90-138` — each child gets independent `ApplyRateFils(netPayout, weightBps)`
- `packages/money` `allocateRemainder` exists and is unused from Go
- `apps/settlement/internal/splits/shares.go` exists and is not used in `PayoutSplitBatch`
- Zero shares are skipped (`AllocatedFils <= 0`) so remainder is dropped

Technical details:
Bankers rounding per child does not conserve the total. The parent cache is debited by `totalAllocated`, not `netPayout`. The leftover fils vanish from the ledger.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Every split batch is a few tens of fils short. Delta Marketplace since launch. The missing fils are nowhere — not residue, not platform, not parent.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue, handwritten note 'splits a few fils short', ADR-0001. Legacy file: `bug-25-split-payout-missing-fils.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Port / call largest-remainder (`allocateRemainder`) in Go. Debit the parent by the full net and give remainder fils to the largest share.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-25-split-payout-missing-fils.md`

## 17. Evidence References

`apps/settlement/internal/splits/allocate.go`, `bug-25-split-payout-missing-fils.md`
