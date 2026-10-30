# BUG-072 — Settlement Summary Query Multiplies Cumulative Captures by Capture Event Count

## 1. Summary

Settlement summary query CTE joins transactions with transaction_events for captures. It performs COUNT(DISTINCT id) but SUM(captured_fils) without deduplication, causing transactions with multiple partial captures to multiply their cumulative captured amounts across the reporting window.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/settlement/query.ts
- Reachability: Reachable via GET /v1/settlement/summary
- Original Contributors / Sources: Handwritten clue on slow query, docs/perf/2026-07, BUG-004

## 3. Root Cause

The CTE joins one transaction to every qualifying capture event but selects the transaction's lifetime `captured_fils` for each joined row. COUNT(DISTINCT id) deduplicates only the count; SUM(captured_fils) retains fanout and uses a value outside the event window.

Event fan-out without aggregating events before joining. Distinct is applied to transaction count only, not amount sums.

## 4. Affected Files and Functions

`apps/api/src/settlement/query.ts:359-386`; `apps/api/src/routes/settlement.ts:77-91`; `apps/api/src/payments/capture.ts:195-203,258-265`; `apps/api/src/routes/settlement.test.ts:415-434`.
- `apps/api/src/settlement/query.ts:366-377`

## 5. Expected Behavior

Gross captured in a window equals the sum of capture-event deltas inside that window.

## 6. Actual Behavior

One transaction with two captures of 4,000 and 6,000 has current captured_fils 10,000. If both events fall in the window, the summary returns 20,000 and count 1. If only the first event is in the window, after the later capture it still returns 10,000 instead of 4,000.

A transaction with two `captured` events (partial captures) contributes its full `captured_fils` twice. The join is also heavy per request.

## 7. Trigger Conditions

A supported partial-capture transaction has more than one successful capture, either inside one period or across periods.

## 8. Technical Evidence

`query.ts:368-376`: `SELECT t.id, t.captured_fils ... JOIN transaction_events te ...` followed by `COUNT(DISTINCT id)` and `SUM(captured_fils)`. Capture updates cumulative `captured_fils` and records `amountFils: requestedAmount` on each event.

- `apps/api/src/settlement/query.ts:366-377` — joins `transactions` × `transaction_events` for captures; `COUNT(DISTINCT id)` but `SUM(captured_fils)` with no dedupe

Authenticated owner/finance → /v1/settlement/summary → getSettlementSummary → event-filtered joined rows → cumulative snapshot summed once per event. This independent join error affects both multi-capture duplication and retrospective period leakage; those are one root cause.

## 9. Runtime Evidence

No runtime reproduction artifact exists; verified through static query inspection and test analysis in `apps/api/src/routes/settlement.test.ts:415-434`.

## 10. Security / Financial / Functional Impact

Settlement gross totals are overstated and historical reports change when later captures occur. This endpoint is read-only; it does not itself charge or pay money.

Gross totals in the settlement summary are high. The page is slow on busy merchants.

## 11. Safe Reproduction

`settlement.test.ts:415-434` explicitly tests transactions with a single capture event. Future cases: two captures on one authorization and one capture per side of the period boundary; assert event-delta totals and distinct transaction count.

## 12. Related Findings

Consolidates legacy Bug 35 and Blind Spot BUG-004. Related to performance report `docs/perf/2026-07-settlement-summary-slow.md`.

## 13. Documentation Contradictions

Architecture states settlement summary represents actual period captures, but query aggregates lifetime cumulative amount per joined event.

## 14. Recommended Remediation

Aggregate te.amount_fils for matching capture events and keep the distinct transaction count separately. No fix implemented.

Smallest fix: Sum event amounts (`SUM(te.amount_fils)` where `event_type = 'captured'`), or aggregate transactions first and then join.

## 15. Remaining Questions and Limitations

No runtime test or historical export correlation performed; exact past incident contribution unknown.

## 16. Original Reports Merged

`bug-35-settlement-summary-double-counts.md`, `bug-4-settlement-summary-multiplies-cumulative-captures.md`

## 17. Evidence References

`apps/api/src/settlement/query.ts`, `docs/perf/2026-07-settlement-summary-slow.md`
