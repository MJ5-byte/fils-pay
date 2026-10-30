# BUG-008 — Concurrent Refunds Both Succeed Allowing Double Money Out

## 1. Summary

Two refunds with different idempotency keys on the same capture both read `refunded_fils = 0`, both pass validation, both hit the acquirer, both post ledger legs.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Refunds
- Affected Component: apps/api/src/payments/processRefund.ts
- Reachability: Reachable via concurrent refund requests
- Original Contributors / Sources: Clue FP-209, loadtest 2026-09

## 3. Root Cause

Lost update. Capture locks the row through the acquirer call; refunds do not.

## 4. Affected Files and Functions

- `apps/api/src/payments/processRefund.ts:73-78, 141-203` — phase 1 reads `transactions` **without `FOR UPDATE`**, commits, calls the acquirer **outside** the DB txn, then writes `refunded_fils` from the **stale** snapshot
- Contrast: `apps/api/src/payments/capture.ts` holds `FOR UPDATE` (that path has the opposite problem — Bug 18)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two refunds with different idempotency keys on the same capture both read `refunded_fils = 0`, both pass validation, both hit the acquirer, both post ledger legs. The later UPDATE can even leave `refunded_fils` looking like a single refund.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/processRefund.ts:73-78, 141-203` — phase 1 reads `transactions` **without `FOR UPDATE`**, commits, calls the acquirer **outside** the DB txn, then writes `refunded_fils` from the **stale** snapshot
- Contrast: `apps/api/src/payments/capture.ts` holds `FOR UPDATE` (that path has the opposite problem — Bug 18)

Technical details:
Two refunds with different idempotency keys on the same capture both read `refunded_fils = 0`, both pass validation, both hit the acquirer, both post ledger legs. The later UPDATE can even leave `refunded_fils` looking like a single refund.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Double (or N-way) money out. Ledger vs acquirer vs `refunded_fils` diverge.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue FP-209, loadtest 2026-09. Legacy file: `bug-14-concurrent-refund-double-money-out.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`SELECT … FOR UPDATE` in phase 1; reserve a pending refund amount before the acquirer call; phase 3 use `refunded_fils = refunded_fils + $2` with `refunded_fils + $2 <= captured_fils`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-14-concurrent-refund-double-money-out.md`

## 17. Evidence References

`apps/api/src/payments/processRefund.ts`, `bug-14-concurrent-refund-double-money-out.md`
