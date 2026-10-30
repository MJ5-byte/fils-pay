# BUG-020 — Reporting Export Summary Endpoint Lacks Authentication Pre-Handler

## 1. Summary

Sibling reporting routes attach `requireMerchantAuth`.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/routes/reporting.ts
- Reachability: Reachable anonymously via HTTP GET
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Copy-paste route missing the preHandler.

## 4. Affected Files and Functions

- `apps/api/src/routes/reporting.ts:79-86` — no `preHandler: requireMerchantAuth`, but the handler reads `request.merchantAuth!.merchantId`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Sibling reporting routes attach `requireMerchantAuth`. This one does not. Unauthenticated calls either 500 on the non-null assertion or, if a plugin stamped a stale identity, leak another merchant's export summary.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/reporting.ts:79-86` — no `preHandler: requireMerchantAuth`, but the handler reads `request.merchantAuth!.merchantId`

Technical details:
Sibling reporting routes attach `requireMerchantAuth`. This one does not. Unauthenticated calls either 500 on the non-null assertion or, if a plugin stamped a stale identity, leak another merchant's export summary.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Unauthenticated 500s, or a cross-tenant data leak if `merchantAuth` is ever populated without this hook.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-58-reporting-export-summary-unauthenticated.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Add the same `preHandler: requireMerchantAuth` as the other reporting routes.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-58-reporting-export-summary-unauthenticated.md`

## 17. Evidence References

`apps/api/src/routes/reporting.ts`, `bug-58-reporting-export-summary-unauthenticated.md`
