# BUG-013 — Janitor Script Deletes All Active Holds When No Expired Holds Are Found

## 1. Summary

A quiet night (`expiredIds = []`) generates `DELETE FROM holds` with no predicate.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Database and migrations
- Affected Component: scripts/expire_holds.ts, scripts/lib/sqlFilter.ts
- Reachability: Reachable via nightly cron execution
- Original Contributors / Sources: HANDOVER, code audit

## 3. Root Cause

Generic SQL builder treats empty `IN ()` as "no filter" instead of "match nothing."

## 4. Affected Files and Functions

- `scripts/expire_holds.ts:17-45` — SELECT expired ids, then `buildDelete("holds", { id: expiredIds })`
- `scripts/lib/sqlFilter.ts:9-10, 24-29` — empty array is skipped, so `WHERE` is omitted → `DELETE FROM holds`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A quiet night (`expiredIds = []`) generates `DELETE FROM holds` with no predicate. Every hold row, including live authorizations, is removed. HANDOVER's "flip active → expired, never delete" is the opposite of the code.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `scripts/expire_holds.ts:17-45` — SELECT expired ids, then `buildDelete("holds", { id: expiredIds })`
- `scripts/lib/sqlFilter.ts:9-10, 24-29` — empty array is skipped, so `WHERE` is omitted → `DELETE FROM holds`

Technical details:
A quiet night (`expiredIds = []`) generates `DELETE FROM holds` with no predicate. Every hold row, including live authorizations, is removed. HANDOVER's "flip active → expired, never delete" is the opposite of the code.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

One cron run wipes the holds table. Capture still proceeds (Bug 17). Authorizations become untraceable.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: HANDOVER, code audit. Legacy file: `bug-32-expire-holds-deletes-every-hold.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

If `expiredIds.length === 0`, skip the DELETE. In `buildWhere`, empty arrays should produce `AND FALSE`. Prefer `UPDATE holds SET status = 'expired' WHERE id = ANY($1)`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-32-expire-holds-deletes-every-hold.md`

## 17. Evidence References

`scripts/expire_holds.ts, scripts/lib/sqlFilter.ts`, `bug-32-expire-holds-deletes-every-hold.md`
