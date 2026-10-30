# Bug 65 — `refund_merchant_summary` joins a refund to a transaction on the wrong key

**Severity:** Medium · **Area:** Database · **Source:** CODE-013

## Where
- `db/migrations/0072_refund_merchant_summary.sql:13-14`

```sql
FROM refunds r
JOIN transactions t ON t.id = r.id
```

The header says the reporting worker refreshes this view after each settlement run. Nothing in the repo calls `REFRESH MATERIALIZED VIEW`.

## What's wrong
`r.id` is the refund's id. The transaction id is `r.transaction_id`. The join matches only when those two uuids happen to be equal, which they are not. `SUM(t.captured_fils)` would also add the capture once per refund if the key were fixed without grouping first. The view is created by migration 0072, which a fresh database never reaches (Bug 57).

## Why
The join column was copied from the refund side.

## What it breaks
The admin refund dashboard, if anyone reads this view, is empty or wrong. The comment that the worker keeps it fresh is false either way.

## Smallest fix
`JOIN transactions t ON t.id = r.transaction_id`, aggregate captures separately from refunds, and refresh the view from the worker that the header already names. Do this only after Bug 57 is fixed, or the migration still never applies.
