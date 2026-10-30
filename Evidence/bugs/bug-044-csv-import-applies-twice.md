# BUG-044 — Adjustment CSV Import Lacks Deduplication Posting Duplicate Ledger Entries

## 1. Summary

Each `POST /v1/admin/adjustment-imports` parses the file and posts a ledger group per row.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/adjustmentImport.ts
- Reachability: Reachable by re-uploading identical CSV file
- Original Contributors / Sources: CODE-010, EVID-014

## 3. Root Cause

Idempotency was described in a comment and never added to the schema.

## 4. Affected Files and Functions

- `apps/api/src/admin/adjustmentImport.ts:56-64` — inserts a new `adjustment_imports` row every time
- Comment on line 64 says a unique `original_filename` blocks a re-upload. No such unique index exists.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Each `POST /v1/admin/adjustment-imports` parses the file and posts a ledger group per row. Uploading the same filename and the same rows a second time creates a second import id and posts the amounts again. EVID-014 did this: two uploads of `4.750` produced two payable credits (950 fils total, already scaled by Bug 19).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/adjustmentImport.ts:56-64` — inserts a new `adjustment_imports` row every time
- Comment on line 64 says a unique `original_filename` blocks a re-upload. No such unique index exists.

Technical details:
Each `POST /v1/admin/adjustment-imports` parses the file and posts a ledger group per row. Uploading the same filename and the same rows a second time creates a second import id and posts the amounts again. EVID-014 did this: two uploads of `4.750` produced two payable credits (950 fils total, already scaled by Bug 19).

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

A double-click or a finance retry doubles every manual adjustment. Combined with Bug 19 the posted total is both wrong and repeated.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: CODE-010, EVID-014. Legacy file: `bug-60-csv-import-applies-twice.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Hash the file (or the parsed rows) and reject a hash already stored. Do not rely on the filename.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-60-csv-import-applies-twice.md`

## 17. Evidence References

`apps/api/src/admin/adjustmentImport.ts`, `bug-60-csv-import-applies-twice.md`
