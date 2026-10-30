# BUG-019 — Reporting Scope Allows Split Merchant Parent to Query Unauthorized Child Data

## 1. Summary

Merchant A can request reports for child C that belongs to parent B, just by knowing C's id..

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/reporting/scope.ts
- Reachability: Reachable via reporting endpoints
- Original Contributors / Sources: AI code audit

## 3. Root Cause

"Is this id a child of someone?" instead of "is this id **my** child?"

## 4. Affected Files and Functions

- `apps/api/src/reporting/scope.ts:12-19` — if `requestedMerchantId` exists in `merchant_split_children` it is accepted; no `parent_merchant_id = caller`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Merchant A can request reports for child C that belongs to parent B, just by knowing C's id.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/reporting/scope.ts:12-19` — if `requestedMerchantId` exists in `merchant_split_children` it is accepted; no `parent_merchant_id = caller`

Technical details:
Merchant A can request reports for child C that belongs to parent B, just by knowing C's id.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Cross-tenant volume, payout, and capture data via the reporting API.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-52-reporting-scope-split-child-idor.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`WHERE child_merchant_id = $1 AND parent_merchant_id = $2`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-52-reporting-scope-split-child-idor.md`

## 17. Evidence References

`apps/api/src/reporting/scope.ts`, `bug-52-reporting-scope-split-child-idor.md`
