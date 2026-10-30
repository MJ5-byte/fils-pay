# BUG-074 — Admin Analytics Rebuild Executes Truncate and Insert in Separate Transactions

## 1. Summary

The reporting worker applies outbox rows with `id > cursor` and then adds into those same tables (Bug 51).

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/admin/analyticsRebuild.ts
- Reachability: Reachable when admin triggers analytics rebuild
- Original Contributors / Sources: AI code audit

## 3. Root Cause

This is a second rebuild, from a different source, beside the worker. The worker's CLI claims there is one path.

## 4. Affected Files and Functions

- `apps/api/src/admin/reportingRebuild.ts:11-36` — `TRUNCATE`s `merchant_daily_volume` and `merchant_payout_trends`, then fills them from `transaction_events` and the current `settlement_batches` rows
- It never reads or writes `reporting_outbox_cursor`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The reporting worker applies outbox rows with `id > cursor` and then adds into those same tables (Bug 51). After this rebuild, every outbox row still ahead of the cursor is applied again, on top of the totals just inserted. `merchant_payout_trends.status` is copied from the batch as it is now, not as it was when the batch closed.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/reportingRebuild.ts:11-36` — `TRUNCATE`s `merchant_daily_volume` and `merchant_payout_trends`, then fills them from `transaction_events` and the current `settlement_batches` rows
- It never reads or writes `reporting_outbox_cursor`

Technical details:
The reporting worker applies outbox rows with `id > cursor` and then adds into those same tables (Bug 51). After this rebuild, every outbox row still ahead of the cursor is applied again, on top of the totals just inserted. `merchant_payout_trends.status` is copied from the batch as it is now, not as it was when the batch closed.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Captured volume and payout trends jump after an admin rebuild, then jump again as the worker catches up. A paid batch can show as closed, or the reverse, depending on when the rebuild ran.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-64-admin-analytics-rebuild-double-counts.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

One function for both the worker and the admin button. After a full rebuild, set the cursor to `MAX(outbox_events.id)` in the same transaction as the truncate.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-64-admin-analytics-rebuild-double-counts.md`

## 17. Evidence References

`apps/api/src/admin/analyticsRebuild.ts`, `bug-64-admin-analytics-rebuild-double-counts.md`
