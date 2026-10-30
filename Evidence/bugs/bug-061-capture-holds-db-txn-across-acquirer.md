# BUG-061 — Capture Endpoint Holds Database Row Lock Open Across Slow External Acquirer Call

## 1. Summary

One pool connection and a row lock are held for the full acquirer RTT, on both authorize and capture.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/payments/capture.ts
- Reachability: Reachable on every transaction capture request
- Original Contributors / Sources: AI code audit

## 3. Root Cause

The lock was added to prevent lost updates (the thing refunds forgot — Bug 14) but the acquirer call was left inside the same transaction.

## 4. Affected Files and Functions

- `apps/api/src/payments/capture.ts:77-178` — `withTransaction` + `FOR UPDATE` from validation through `await acquirer.capture(...)` until commit
- `apps/api/src/payments/authorize.ts:57-93` — the same pattern around `acquirer.authorize`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

One pool connection and a row lock are held for the full acquirer RTT, on both authorize and capture. Payment-link pay does both, so it holds two connections in sequence. When the pool (max 5) is busy, the next request does not hang: `connectionTimeoutMillis` defaults to 5 seconds (`config.ts`, `PG_POOL_CONNECTION_TIMEOUT_MS`) and the request fails.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/capture.ts:77-178` — `withTransaction` + `FOR UPDATE` from validation through `await acquirer.capture(...)` until commit
- `apps/api/src/payments/authorize.ts:57-93` — the same pattern around `acquirer.authorize`

Technical details:
One pool connection and a row lock are held for the full acquirer RTT, on both authorize and capture. Payment-link pay does both, so it holds two connections in sequence. When the pool (max 5) is busy, the next request does not hang: `connectionTimeoutMillis` defaults to 5 seconds (`config.ts`, `PG_POOL_CONNECTION_TIMEOUT_MS`) and the request fails.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

API-wide timeouts, lock contention, cascading 500s. Not a money-loss bug by itself, but it is why capture "doesn't have" the concurrent double-capture problem — at the cost of availability.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-18-capture-holds-db-txn-across-acquirer.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Short txn: lock, validate, record intent. Acquirer outside. Second txn applies the result (with the same `FOR UPDATE` guard). Do **not** copy refund's current pattern.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-18-capture-holds-db-txn-across-acquirer.md`

## 17. Evidence References

`apps/api/src/payments/capture.ts`, `bug-18-capture-holds-db-txn-across-acquirer.md`
