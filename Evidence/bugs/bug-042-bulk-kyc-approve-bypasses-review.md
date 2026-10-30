# BUG-042 — Bulk KYC Approval Transitions Pending Merchants Directly to Approved

## 1. Summary

Merchants who never submitted, or who were rejected, can be flipped to approved in bulk.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/bulkKyc.ts
- Reachability: Reachable via bulk KYC approve endpoint
- Original Contributors / Sources: ADMIN.md, code audit

## 3. Root Cause

A convenience endpoint that updates the flag and skips the function that exists for the real path.

## 4. Affected Files and Functions

- `apps/api/src/admin/bulkKyc.ts:26-31` — `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true` with no `under_review` guard and no `merchant_kyc_reviews` row
- Contrast: `apps/api/src/onboarding/review.ts` writes a review row per merchant

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Merchants who never submitted, or who were rejected, can be flipped to approved in bulk. There is no reviewer identity on a `merchant_kyc_reviews` row.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/bulkKyc.ts:26-31` — `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true` with no `under_review` guard and no `merchant_kyc_reviews` row
- Contrast: `apps/api/src/onboarding/review.ts` writes a review row per merchant

Technical details:
Merchants who never submitted, or who were rejected, can be flipped to approved in bulk. There is no reviewer identity on a `merchant_kyc_reviews` row.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Unreviewed shops take live traffic. Audit cannot say who approved them.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ADMIN.md, code audit. Legacy file: `bug-49-bulk-kyc-approve-bypasses-review.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`WHERE onboarding_status = 'under_review'` and call `recordKycReviewInTx` per id.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-49-bulk-kyc-approve-bypasses-review.md`

## 17. Evidence References

`apps/api/src/admin/bulkKyc.ts`, `bug-49-bulk-kyc-approve-bypasses-review.md`
