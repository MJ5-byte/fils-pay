# BUG-012 — Merchant Status Recomputation Clears Test Mode Flag Polluting Live Settlement

## 1. Summary

The tool is supposed to recompute transaction statuses.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/merchantStatus.ts
- Reachability: Reachable via admin merchant status job
- Original Contributors / Sources: Clue 'Test merchants in real settlement'

## 3. Root Cause

Sandbox-clearing heuristic bolted onto a status rebuild. Wrong candidate filter.

## 4. Affected Files and Functions

- `apps/api/src/admin/transactionStatusRecompute.ts:26-30` — candidates exclude `authorized`, so `openAuthorizations` is always 0
- `apps/api/src/admin/merchantFlags.ts:10-17` — if `scanned > 0 && openAuthorizations === 0`, `UPDATE merchants SET test_mode = false`
- `apps/settlement/.../batch.go` — `CloseBatch` requires `test_mode = false`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The tool is supposed to recompute transaction statuses. As a side effect it marks the merchant live. Because authorized txns are excluded from the scan, every merchant with any captured/settled history looks like "no open auths" and is flipped to live.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/transactionStatusRecompute.ts:26-30` — candidates exclude `authorized`, so `openAuthorizations` is always 0
- `apps/api/src/admin/merchantFlags.ts:10-17` — if `scanned > 0 && openAuthorizations === 0`, `UPDATE merchants SET test_mode = false`
- `apps/settlement/.../batch.go` — `CloseBatch` requires `test_mode = false`

Technical details:
The tool is supposed to recompute transaction statuses. As a side effect it marks the merchant live. Because authorized txns are excluded from the scan, every merchant with any captured/settled history looks like "no open auths" and is flipped to live.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Test captures hit production settlement, scheme export, and payouts.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'Test merchants in real settlement'. Legacy file: `bug-30-recompute-statuses-clears-test-mode.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Never auto-clear `test_mode` from this tool. If a live-promotion path is needed, make it an explicit admin action with a role check.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-30-recompute-statuses-clears-test-mode.md`

## 17. Evidence References

`apps/api/src/admin/merchantStatus.ts`, `bug-30-recompute-statuses-clears-test-mode.md`
