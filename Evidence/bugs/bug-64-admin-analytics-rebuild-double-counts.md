# Bug 64 — Admin "rebuild analytics" does not move the outbox cursor

**Severity:** Medium · **Area:** Reporting · **Source:** CODE-027

## Where
- `apps/api/src/admin/reportingRebuild.ts:11-36` — `TRUNCATE`s `merchant_daily_volume` and `merchant_payout_trends`, then fills them from `transaction_events` and the current `settlement_batches` rows
- It never reads or writes `reporting_outbox_cursor`

## What's wrong
The reporting worker applies outbox rows with `id > cursor` and then adds into those same tables (Bug 51). After this rebuild, every outbox row still ahead of the cursor is applied again, on top of the totals just inserted. `merchant_payout_trends.status` is copied from the batch as it is now, not as it was when the batch closed.

## Why
This is a second rebuild, from a different source, beside the worker. The worker's CLI claims there is one path.

## What it breaks
Captured volume and payout trends jump after an admin rebuild, then jump again as the worker catches up. A paid batch can show as closed, or the reverse, depending on when the rebuild ran.

## Smallest fix
One function for both the worker and the admin button. After a full rebuild, set the cursor to `MAX(outbox_events.id)` in the same transaction as the truncate.
