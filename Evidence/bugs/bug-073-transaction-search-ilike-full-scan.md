# BUG-073 — Transaction Search Uses Unindexed Leading Wildcard ILIKE Causing Full-Table Scan

## 1. Summary

Every search is a sequential scan per merchant.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/routes/transactions.ts
- Reachability: Reachable via transaction search query parameter
- Original Contributors / Sources: Clue on slow reporting query

## 3. Root Cause

"Just make find work" with a leading `%`.

## 4. Affected Files and Functions

- `apps/api/src/transactions/query.ts:96-113` — leading-wildcard ILIKE on `reference` and `acquirer_reference`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Every search is a sequential scan per merchant. In-file comment already flags it.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/transactions/query.ts:96-113` — leading-wildcard ILIKE on `reference` and `acquirer_reference`

Technical details:
Every search is a sequential scan per merchant. In-file comment already flags it.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Dashboard search p95 blows up as volume grows. Can take the API with it (same pool as payments).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue on slow reporting query. Legacy file: `bug-53-transaction-search-ilike-full-scan.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Prefix search (`ILIKE $q || '%'`) plus a `text_pattern_ops` index, or `pg_trgm` GIN if infix search is required.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-53-transaction-search-ilike-full-scan.md`

## 17. Evidence References

`apps/api/src/routes/transactions.ts`, `bug-53-transaction-search-ilike-full-scan.md`
