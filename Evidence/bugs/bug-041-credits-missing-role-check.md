# BUG-041 — Credit Adjustment Creation Endpoint Lacks Administrator Role Check

## 1. Summary

Any logged-in admin, including `support`, can create a credit.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Admin console and controls
- Affected Component: apps/api/src/routes/adminCredits.ts
- Reachability: Reachable by support/auditor admin roles
- Original Contributors / Sources: Code audit

## 3. Root Cause

Role check was added to the approve path and forgotten on create.

## 4. Affected Files and Functions

- `apps/api/src/routes/adminCredits.ts` — `POST /merchants/:id/credits` is only `requireAdminSession`
- Approve/reject correctly require `finance` | `super_admin`
- `createCreditRequest` can auto-post when under the dual-control threshold

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Any logged-in admin, including `support`, can create a credit. Under-threshold requests post to the ledger immediately.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/adminCredits.ts` — `POST /merchants/:id/credits` is only `requireAdminSession`
- Approve/reject correctly require `finance` | `super_admin`
- `createCreditRequest` can auto-post when under the dual-control threshold

Technical details:
Any logged-in admin, including `support`, can create a credit. Under-threshold requests post to the ledger immediately.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Support can move money. Combined with Bug 45, a single operator can also approve the rest.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Code audit. Legacy file: `bug-46-credits-missing-role-check.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`requireAdminRole("finance", "super_admin")` on create, same as approve.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-46-credits-missing-role-check.md`

## 17. Evidence References

`apps/api/src/routes/adminCredits.ts`, `bug-46-credits-missing-role-check.md`
