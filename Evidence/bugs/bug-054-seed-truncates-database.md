# BUG-054 — Database Seed Script Executes Unconditional TRUNCATE Wiping Existing Data

## 1. Summary

The seed is not an upsert.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Database and migrations
- Affected Component: db/seed.ts
- Reachability: Reachable on npm run seed execution
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Fixture generator was written as "reset then fill" and the comment was never made true.

## 4. Affected Files and Functions

- `db/seed/generate.ts:110-138, 210-212` — `TRUNCATE merchants, transactions, ledger_entries, … RESTART IDENTITY CASCADE` while a comment claims it is safe on shared/staging

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The seed is not an upsert. It wipes merchants, ledger, batches, admin users, sessions. Running it against anything other than an empty local DB is destructive.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `db/seed/generate.ts:110-138, 210-212` — `TRUNCATE merchants, transactions, ledger_entries, … RESTART IDENTITY CASCADE` while a comment claims it is safe on shared/staging

Technical details:
The seed is not an upsert. It wipes merchants, ledger, batches, admin users, sessions. Running it against anything other than an empty local DB is destructive.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Accidental wipe of staging (or worse). Combined with Bug 57, recovering a fresh environment is already hard.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-33-seed-truncates-database.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Refuse to run unless `ALLOW_DESTRUCTIVE_SEED=1` and the database name matches a local/dev allowlist.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-33-seed-truncates-database.md`

## 17. Evidence References

`db/seed.ts`, `bug-33-seed-truncates-database.md`
