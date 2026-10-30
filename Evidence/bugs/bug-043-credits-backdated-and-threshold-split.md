# BUG-043 — Manual Credit Creation Allows Backdating Into Closed Settlement Periods

## 1. Summary

Any real `YYYY-MM-DD`, including tomorrow and a closed month, is accepted, and both ledger legs are dated that day.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/credits.ts
- Reachability: Reachable via admin credit creation
- Original Contributors / Sources: YA handover, code audit

## 3. Root Cause

The validator's comment describes a rule the function does not implement. The threshold ignores the fee reversal on purpose (comment in `credits.ts`); nothing sums the day's credits.

## 4. Affected Files and Functions

- `apps/api/src/admin/creditRequestValidation.ts:12-13,76-82` — doc says future dates are rejected; the code only checks that the string is a real calendar day
- `apps/api/src/admin/credits.ts:149-172,221-228` — ledger `occurred_at` is Bahrain midnight of `effectiveDate`; fee reversal uses `merchants.mdr_bps`
- `apps/api/src/admin/creditThreshold.ts:10-16` — second approver only when `baseAmountFils > 50_000`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Any real `YYYY-MM-DD`, including tomorrow and a closed month, is accepted, and both ledger legs are dated that day. The fee handed back is the merchant's current default rate, not the `fee_schedules` rate charged at capture. Approval looks at the base amount only, with no daily total, so two credits of 50.000 BD each post with one operator. Exactly 50 000 fils does not trip the check (`>` not `>=`).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/creditRequestValidation.ts:12-13,76-82` — doc says future dates are rejected; the code only checks that the string is a real calendar day
- `apps/api/src/admin/credits.ts:149-172,221-228` — ledger `occurred_at` is Bahrain midnight of `effectiveDate`; fee reversal uses `merchants.mdr_bps`
- `apps/api/src/admin/creditThreshold.ts:10-16` — second approver only when `baseAmountFils > 50_000`

Technical details:
Any real `YYYY-MM-DD`, including tomorrow and a closed month, is accepted, and both ledger legs are dated that day. The fee handed back is the merchant's current default rate, not the `fee_schedules` rate charged at capture. Approval looks at the base amount only, with no daily total, so two credits of 50.000 BD each post with one operator. Exactly 50 000 fils does not trip the check (`>` not `>=`).

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A credit lands inside an already-closed settlement period. The reversal does not match the fee that was charged. Support-or-finance (see Bug 46) can move arbitrary money by staying at or under 50.000 BD per request.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: YA handover, code audit. Legacy file: `bug-59-credits-backdated-and-threshold-split.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Reject `effectiveDate` after today (Bahrain). Reverse the fee from the schedule that applied to the original capture, or do not reverse a fee that was never charged. Compare admin user ids is Bug 45; here, compare the sum of credits for the merchant that day, and use `>=` on the threshold.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-59-credits-backdated-and-threshold-split.md`

## 17. Evidence References

`apps/api/src/admin/credits.ts`, `bug-59-credits-backdated-and-threshold-split.md`
