# BUG-064 — Daily Settlement Batch Loop Aborts on First Merchant Failure Blocking Rest

## 1. Summary

`ErrMerchantNotEligible` is skipped.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/settlement/batch.go
- Reachability: Reachable when any single merchant in settlement run throws an error
- Original Contributors / Sources: AI code audit

## 3. Root Cause

The loop treats one merchant's failure as a failure of the whole day.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/batch.go:427-439` — merchants are sorted by id, then `CloseBatch` / `PayoutBatch` errors return from `RunDailyBatch` immediately
- `apps/settlement/internal/scheduler/daemon.go:92-95` — the daemon logs that error and waits for the next 60 s tick, which starts the same loop again

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`ErrMerchantNotEligible` is skipped. Every other error aborts the function. Merchants later in id order are not closed or paid on that tick. The failing merchant is still first among those not yet done, so the same error blocks the tail on every tick until someone fixes that merchant.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/batch.go:427-439` — merchants are sorted by id, then `CloseBatch` / `PayoutBatch` errors return from `RunDailyBatch` immediately
- `apps/settlement/internal/scheduler/daemon.go:92-95` — the daemon logs that error and waits for the next 60 s tick, which starts the same loop again

Technical details:
`ErrMerchantNotEligible` is skipped. Every other error aborts the function. Merchants later in id order are not closed or paid on that tick. The failing merchant is still first among those not yet done, so the same error blocks the tail on every tick until someone fixes that merchant.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A single bad fee schedule, lock timeout, or data error holds payout for every merchant sorted after it.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-62-daily-batch-stops-on-first-merchant.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Record the merchant error on the report and continue. Alert on the failed id. Do not `return` out of the loop.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-62-daily-batch-stops-on-first-merchant.md`

## 17. Evidence References

`apps/settlement/internal/settlement/batch.go`, `bug-62-daily-batch-stops-on-first-merchant.md`
