# Bug 35 — Settlement summary double-counts captures and is slow

**Severity:** Medium · **Area:** Reporting · **Clue:** Handwritten — *"one of the reporting queries is suspiciously slow"*; `docs/perf/2026-07-settlement-summary-slow.md`

## Where
- `apps/api/src/settlement/query.ts:366-377` — joins `transactions` × `transaction_events` for captures; `COUNT(DISTINCT id)` but `SUM(captured_fils)` with no dedupe

## What's wrong
A transaction with two `captured` events (partial captures) contributes its full `captured_fils` twice. The join is also heavy per request.

## Why
Event fan-out without aggregating events. Distinct is applied to the count only.

## What it breaks
Gross totals in the settlement summary are high. The page is slow on busy merchants.

## Smallest fix
Sum event amounts (`SUM(te.amount_fils)` where `event_type = 'captured'`), or aggregate transactions first and then join.
