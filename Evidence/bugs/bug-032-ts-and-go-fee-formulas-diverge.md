# BUG-032 — TypeScript API Fee Calculation and Go Settlement Fee Formulas Diverge

## 1. Summary

Two different formulas.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/api/src/payments/capture.ts, apps/settlement/internal/settlement/discounted_fee.go
- Reachability: Reachable on transactions with negotiated discounts
- Original Contributors / Sources: Finance clue, ADR-0001

## 3. Root Cause

Discount was added in the API as a display/ledger adjustment and re-implemented in Go as an amount reduction. Nobody made them identical.

## 4. Affected Files and Functions

- Go: `apps/settlement/internal/settlement/discounted_fee.go` — discount **the amount**, then apply MDR
- TS: `apps/api/src/payments/capture.ts` + `discountAdjustment.ts` — full MDR on capture, then a separate discount **on the fee**

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two different formulas. For `negotiated_discount_bps > 0` the ledger fee legs (API) do not match `settlement_batches.fee_fils` (Go). Payment-link captures skip the TS discount entirely (Bug 11), so they disagree a third way.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- Go: `apps/settlement/internal/settlement/discounted_fee.go` — discount **the amount**, then apply MDR
- TS: `apps/api/src/payments/capture.ts` + `discountAdjustment.ts` — full MDR on capture, then a separate discount **on the fee**

Technical details:
Two different formulas. For `negotiated_discount_bps > 0` the ledger fee legs (API) do not match `settlement_batches.fee_fils` (Go). Payment-link captures skip the TS discount entirely (Bug 11), so they disagree a third way.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Batch close vs ledger vs merchant dashboard never tie for discounted merchants (Delta Marketplace).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue, ADR-0001. Legacy file: `bug-31-ts-and-go-fee-formulas-diverge.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

One function. Prefer: MDR on (amount − discount), integer fils, called from both capture and `CloseBatch`. Include the discount in payment-link pay (Bug 11).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-31-ts-and-go-fee-formulas-diverge.md`

## 17. Evidence References

`apps/api/src/payments/capture.ts, apps/settlement/internal/settlement/discounted_fee.go`, `bug-31-ts-and-go-fee-formulas-diverge.md`
