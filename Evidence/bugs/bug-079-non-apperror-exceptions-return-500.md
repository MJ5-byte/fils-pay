# BUG-079 — Unexpected Database Exceptions Bypass AppError Handler and Return Generic 500

## 1. Summary

Client mistakes look like outages.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Infrastructure and configuration
- Affected Component: apps/api/src/plugins/errorHandler.ts
- Reachability: Reachable on uncaught database constraints or connection failures
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Error handler only knows the in-house hierarchy.

## 4. Affected Files and Functions

- `apps/api/src/plugins/errorHandler.ts:16-35` — only `AppError` is mapped
- `packages/money/src/fils.ts:35-44` — `toFils(1.5)` throws `RangeError`
- Invalid UUID path params hit Postgres `22P02` → unhandled

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Client mistakes look like outages. Idempotent clients retry 500s and can double-submit (Bugs 7, 14).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/plugins/errorHandler.ts:16-35` — only `AppError` is mapped
- `packages/money/src/fils.ts:35-44` — `toFils(1.5)` throws `RangeError`
- Invalid UUID path params hit Postgres `22P02` → unhandled

Technical details:
Client mistakes look like outages. Idempotent clients retry 500s and can double-submit (Bugs 7, 14).

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Noise in on-call, retries that move money twice.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-56-non-apperror-exceptions-return-500.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Map `RangeError` → 400. Validate UUIDs before the query. Map `pg` `22P02` to 400.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-56-non-apperror-exceptions-return-500.md`

## 17. Evidence References

`apps/api/src/plugins/errorHandler.ts`, `bug-56-non-apperror-exceptions-return-500.md`
