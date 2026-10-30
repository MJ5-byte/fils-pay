# BUG-048 — Duplicate Acquirer Callbacks Append Duplicate Transaction Notes

## 1. Summary

The bank sending the same callback twice creates two identical notes.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Webhooks
- Affected Component: apps/api/src/routes/acquirerCallbacks.ts
- Reachability: Reachable by sending repeated callback payloads
- Original Contributors / Sources: Support FP-201, postmortem 1.9.0

## 3. Root Cause

Dedupe was described, not implemented. `callback_id` is stored as data, not as a key.

## 4. Affected Files and Functions

- `apps/api/src/acquirer/callbacks.ts:37-50` — plain INSERT
- `db/migrations/0051_acquirer_callback_notes.sql` — explicitly **no** unique on `callback_id`
- Commit `bf66bf25` subject: "fix: callbacks are deduplicated now" (the ledger-note is a decoy; the unique index was never added)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The bank sending the same callback twice creates two identical notes. There is no `processed_events` table. 1.9.0 claimed a fix; the migration comment is the opposite.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/acquirer/callbacks.ts:37-50` — plain INSERT
- `db/migrations/0051_acquirer_callback_notes.sql` — explicitly **no** unique on `callback_id`
- Commit `bf66bf25` subject: "fix: callbacks are deduplicated now" (the ledger-note is a decoy; the unique index was never added)

Technical details:
The bank sending the same callback twice creates two identical notes. There is no `processed_events` table. 1.9.0 claimed a fix; the migration comment is the opposite.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Fraud/clear notes appear twice. Support acts twice. Combined with Bug 38, an attacker can append forever.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support FP-201, postmortem 1.9.0. Legacy file: `bug-39-duplicate-acquirer-callback-notes.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`UNIQUE (callback_id)` + `INSERT … ON CONFLICT DO NOTHING`, return 200.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-39-duplicate-acquirer-callback-notes.md`

## 17. Evidence References

`apps/api/src/routes/acquirerCallbacks.ts`, `bug-39-duplicate-acquirer-callback-notes.md`
