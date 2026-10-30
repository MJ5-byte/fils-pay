# BUG-007 — Refund Headroom Capped at Authorized Amount Instead of Captured Amount

## 1. Summary

A payment authorized at 10_000 fils and captured at 4_000 fils can be refunded up to 10_000.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Refunds
- Affected Component: apps/api/src/payments/processRefund.ts
- Reachability: Reachable when refund endpoint is wired
- Original Contributors / Sources: Clue 'Refund more than charged', CODE-009

## 3. Root Cause

Ceiling uses `amount_fils` (the original authorization) instead of `captured_fils`.

## 4. Affected Files and Functions

- `apps/api/src/payments/processRefund.ts:86-90`

```ts
const refundableFils = subtractFils(amountAuthorized, refundedFils);
```

- `apps/api/src/payments/refundValidation.ts` validates against the `refundableFils` it is given
- `packages/money` `calculateRefundFee` scales fee with no captured cap

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A payment authorized at 10_000 fils and captured at 4_000 fils can be refunded up to 10_000. Fee reversal can exceed the fee that was actually charged.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/processRefund.ts:86-90`

```ts
const refundableFils = subtractFils(amountAuthorized, refundedFils);
```

- `apps/api/src/payments/refundValidation.ts` validates against the `refundableFils` it is given
- `packages/money` `calculateRefundFee` scales fee with no captured cap

Technical details:
A payment authorized at 10_000 fils and captured at 4_000 fils can be refunded up to 10_000. Fee reversal can exceed the fee that was actually charged.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Money leaves the platform that never arrived. Partial captures become a free over-refund.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'Refund more than charged', CODE-009. Legacy file: `bug-13-refund-more-than-captured.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`refundableFils = subtractFils(capturedFils, refundedFils)`. Cap fee reversal at the capture-time fee.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-13-refund-more-than-captured.md`

## 17. Evidence References

`apps/api/src/payments/processRefund.ts`, `bug-13-refund-more-than-captured.md`
