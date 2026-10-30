# BUG-055 — Double-Entry Ledger and Audit Tables Lack Immutability Database Triggers

## 1. Summary

Money history and admin audit are mutable.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Database and migrations
- Affected Component: db/migrations/0007_ledger_double_entry.sql
- Reachability: Reachable via direct SQL access or compromised handler
- Original Contributors / Sources: ARCHITECTURE, code audit

## 3. Root Cause

The trigger was written to keep books balanced, not to keep them honest.

## 4. Affected Files and Functions

- `db/migrations/0007_ledger_double_entry.sql:67-74` — trigger enforces **balance** on UPDATE/DELETE of a group, not append-only. A balanced UPDATE/DELETE succeeds.
- `apps/api/src/adminAudit/log.ts:103-114` — `markAdminAuditOutcome` UPDATEs rows; no immutability trigger (comment claims one)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Money history and admin audit are mutable. Architecture's "corrections are new entries" is not enforced.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `db/migrations/0007_ledger_double_entry.sql:67-74` — trigger enforces **balance** on UPDATE/DELETE of a group, not append-only. A balanced UPDATE/DELETE succeeds.
- `apps/api/src/adminAudit/log.ts:103-114` — `markAdminAuditOutcome` UPDATEs rows; no immutability trigger (comment claims one)

Technical details:
Money history and admin audit are mutable. Architecture's "corrections are new entries" is not enforced.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

An operator (or a bug, or Bug 32's style of script) can rewrite the past without a compensating entry. Auditors cannot trust either table.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ARCHITECTURE, code audit. Legacy file: `bug-55-ledger-and-audit-not-immutable.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`BEFORE UPDATE OR DELETE` on `ledger_entries` always RAISE. Audit: append-only outcome events, or forbid UPDATE except filling NULL columns once.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-55-ledger-and-audit-not-immutable.md`

## 17. Evidence References

`db/migrations/0007_ledger_double_entry.sql`, `bug-55-ledger-and-audit-not-immutable.md`
