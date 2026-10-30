# BUG-052 — Reporting Consumer Double-Applies Events on Restart Due to Non-Atomic Watermark

## 1. Summary

Two workers (daemon + catch-up) can read the same cursor, both apply `transaction.captured` (+1 volume), both write the same new watermark.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/reporting/consumer.ts
- Reachability: Reachable on reporting consumer restart or concurrent workers
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Single-writer assumption, no row lock, catch-up was documented as safe.

## 4. Affected Files and Functions

- `apps/reporting/src/consumer/cursor.ts:23-37` — `readCursor` has no `FOR UPDATE`
- `apps/reporting/src/consumer/runConsumerPass.ts:42-66` — one failing event rolls back the whole batch; watermark does not advance
- `apps/reporting/src/cli/catchUp.ts` — explicitly allowed to run while the worker is live

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two workers (daemon + catch-up) can read the same cursor, both apply `transaction.captured` (+1 volume), both write the same new watermark. A poison-pill event blocks every later event until ops deletes it — those look "skipped."

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/reporting/src/consumer/cursor.ts:23-37` — `readCursor` has no `FOR UPDATE`
- `apps/reporting/src/consumer/runConsumerPass.ts:42-66` — one failing event rolls back the whole batch; watermark does not advance
- `apps/reporting/src/cli/catchUp.ts` — explicitly allowed to run while the worker is live

Technical details:
Two workers (daemon + catch-up) can read the same cursor, both apply `transaction.captured` (+1 volume), both write the same new watermark. A poison-pill event blocks every later event until ops deletes it — those look "skipped."

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Inflated `merchant_daily_volume`. Stale rollups until a manual cursor move. FP-300 "shows up right in the reports" fails.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-51-reporting-consumer-double-applies.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`SELECT … FOR UPDATE` on the cursor row at the start of the pass. Dead-letter a poison row and advance past it.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-51-reporting-consumer-double-applies.md`

## 17. Evidence References

`apps/api/src/reporting/consumer.ts`, `bug-51-reporting-consumer-double-applies.md`
