# BUG-037 — Settlement Batch Closure Freezes Arbitrary Dates Permanently

## 1. Summary

Finance or super_admin can close today, or a future date.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/settlement/batch.go
- Reachability: Reachable on CloseBatch call with arbitrary date
- Original Contributors / Sources: RUNBOOK, ADMIN.md

## 3. Root Cause

"Re-run is safe" in the runbook assumes a closed day can be recomputed. The code treats closed as final and does not check that the day has ended.

## 4. Affected Files and Functions

- `apps/api/src/routes/admin.ts:109-123` — `POST /v1/admin/settlement/run-batch` checks that `date` matches `YYYY-MM-DD` and nothing else
- `apps/settlement/internal/settlement/batch.go:93-111` — a batch that is not `open` is a no-op. Nothing reopens it.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Finance or super_admin can close today, or a future date. `CloseBatch` inserts the batch, finds whatever captures already exist in that Bahrain window (often none), and freezes it. Later captures in the same window keep `settlement_batch_id` NULL. The next daemon tick and every manual re-run see a non-open batch and skip them.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/admin.ts:109-123` — `POST /v1/admin/settlement/run-batch` checks that `date` matches `YYYY-MM-DD` and nothing else
- `apps/settlement/internal/settlement/batch.go:93-111` — a batch that is not `open` is a no-op. Nothing reopens it.

Technical details:
Finance or super_admin can close today, or a future date. `CloseBatch` inserts the batch, finds whatever captures already exist in that Bahrain window (often none), and freezes it. Later captures in the same window keep `settlement_batch_id` NULL. The next daemon tick and every manual re-run see a non-open batch and skip them.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A premature run drops the rest of that day's money out of settlement forever. Between 00:00 and 03:00 Bahrain the daemon itself targets the wrong date (Bug 27); a manual run of "today" does the same damage on purpose.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: RUNBOOK, ADMIN.md. Legacy file: `bug-61-settlement-close-any-date-is-final.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Reject any date that is not a completed Bahrain business day. Do not insert a batch row until there is something to close, or leave the row `open` until the window has ended.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-61-settlement-close-any-date-is-final.md`

## 17. Evidence References

`apps/settlement/internal/settlement/batch.go`, `bug-61-settlement-close-any-date-is-final.md`
