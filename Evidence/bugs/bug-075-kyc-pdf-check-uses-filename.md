# BUG-075 — KYC Document Verification Validates File Extension Instead of Magic Bytes

## 1. Summary

Content-type detection exists but the PDF rule does not use it.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/api/src/routes/kyc.ts
- Reachability: Reachable on KYC document upload
- Original Contributors / Sources: ARCHITECTURE, code audit

## 3. Root Cause

Filename extension was cheaper than looking at `detected`.

## 4. Affected Files and Functions

- `apps/api/src/onboarding/kyc.ts:50-68` — PDF-only document types require a `.pdf` suffix on `fileName`; a JPEG named `x.pdf` passes

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Content-type detection exists but the PDF rule does not use it. Architecture's magic-byte claim is false for the constraint that matters.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/onboarding/kyc.ts:50-68` — PDF-only document types require a `.pdf` suffix on `fileName`; a JPEG named `x.pdf` passes

Technical details:
Content-type detection exists but the PDF rule does not use it. Architecture's magic-byte claim is false for the constraint that matters.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Non-PDF KYC documents enter the queue labelled as PDFs. Reviewers approve garbage. Combined with Bug 49, they can be bulk-approved.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ARCHITECTURE, code audit. Legacy file: `bug-48-kyc-pdf-check-uses-filename.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

For PDF-only types, require `detected === 'pdf'` (and keep the extension check if you want).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-48-kyc-pdf-check-uses-filename.md`

## 17. Evidence References

`apps/api/src/routes/kyc.ts`, `bug-48-kyc-pdf-check-uses-filename.md`
