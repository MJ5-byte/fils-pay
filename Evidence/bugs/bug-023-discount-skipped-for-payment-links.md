# BUG-023 — Negotiated Fee Discount Skipped for Hosted Payment Link Captures

## 1. Summary

Hosted-checkout pay never posts the discount adjustment ledger group.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/paymentLinks/pay.ts
- Reachability: Reachable during payment link checkout
- Original Contributors / Sources: Finance clue on discount mismatch

## 3. Root Cause

Discount lives in the HTTP route, not inside `captureTransaction`. Payment-link pay intentionally "never issuing an HTTP request back into the API's own /v1/transactions routes," so it skipped the side effect.

## 4. Affected Files and Functions

- `apps/api/src/paymentLinks/pay.ts:114-126` — calls `captureTransaction` only
- `apps/api/src/routes/transactions.ts` — API capture path then calls `applyCaptureDiscountAdjustment`
- `apps/api/src/payments/discountAdjustment.ts`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Hosted-checkout pay never posts the discount adjustment ledger group. Merchants with `negotiated_discount_bps > 0` (e.g. Delta Marketplace) are charged full MDR on every payment-link capture, while direct `/v1/transactions` captures get the discount.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/paymentLinks/pay.ts:114-126` — calls `captureTransaction` only
- `apps/api/src/routes/transactions.ts` — API capture path then calls `applyCaptureDiscountAdjustment`
- `apps/api/src/payments/discountAdjustment.ts`

Technical details:
Hosted-checkout pay never posts the discount adjustment ledger group. Merchants with `negotiated_discount_bps > 0` (e.g. Delta Marketplace) are charged full MDR on every payment-link capture, while direct `/v1/transactions` captures get the discount.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Wrong fees, wrong merchant payable, wrong settlement vs dashboard. Combined with Bug 31 (TS vs Go fee formulas) the ledger and the batch never agree for discounted merchants.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue on discount mismatch. Legacy file: `bug-11-discount-skipped-for-payment-links.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Call `applyCaptureDiscountAdjustment` after a successful capture inside `payPaymentLink`, or move the adjustment into `captureTransaction`'s commit path so every caller gets it.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-11-discount-skipped-for-payment-links.md`

## 17. Evidence References

`apps/api/src/paymentLinks/pay.ts`, `bug-11-discount-skipped-for-payment-links.md`
