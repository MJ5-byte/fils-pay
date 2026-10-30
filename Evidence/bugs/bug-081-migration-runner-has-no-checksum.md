# BUG-081 — Migration Runner Lacks Checksum Verification Allowing Retroactive File Edits

## 1. Summary

Editing an already-applied `.sql` file, including a comment, does not change what a database that already passed that filename will do.

## 2. Classification

- Severity: Low
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Database and migrations
- Affected Component: db/migrate.ts
- Reachability: Reachable when running database migrations
- Original Contributors / Sources: AI code audit

## 3. Root Cause

The checksum was written into the comment when the table was created without that column.

## 4. Affected Files and Functions

- `db/migrate.ts:71-77` — `schema_migrations` is `(filename, applied_at)`
- Lines 67-69 say the table also stores a checksum and refuses to run if an applied file changed. It does not.
- `listMigrationFiles` sorts names and applies each file in its own transaction. There is no advisory lock.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Editing an already-applied `.sql` file, including a comment, does not change what a database that already passed that filename will do. Two migrators starting together can both decide a file is pending. Gaps in the numbers (0039, 0041, 0059, 0062, 0063, 0067) are harmless; the runner does not require a continuous sequence. The failure on a fresh database is Bug 57, not the gaps.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `db/migrate.ts:71-77` — `schema_migrations` is `(filename, applied_at)`
- Lines 67-69 say the table also stores a checksum and refuses to run if an applied file changed. It does not.
- `listMigrationFiles` sorts names and applies each file in its own transaction. There is no advisory lock.

Technical details:
Editing an already-applied `.sql` file, including a comment, does not change what a database that already passed that filename will do. Two migrators starting together can both decide a file is pending. Gaps in the numbers (0039, 0041, 0059, 0062, 0063, 0067) are harmless; the runner does not require a continuous sequence. The failure on a fresh database is Bug 57, not the gaps.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A "fixed" migration that is edited in place never reaches databases that already applied the old text. Overlapping migrate jobs can both try the same file.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-70-migration-runner-has-no-checksum.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Store `sha256` of the file body and fail when it disagrees with the applied row. Take `pg_advisory_lock` for the duration of `main`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-70-migration-runner-has-no-checksum.md`

## 17. Evidence References

`db/migrate.ts`, `bug-70-migration-runner-has-no-checksum.md`
