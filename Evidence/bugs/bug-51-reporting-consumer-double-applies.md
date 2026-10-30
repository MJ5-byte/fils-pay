# Bug 51 — Reporting consumer can double-apply, or stall on one bad event

**Severity:** High · **Area:** Reporting · **Clue:** Handwritten slow query / exports; Architecture outbox cursor "advanced transactionally"

## Where
- `apps/reporting/src/consumer/cursor.ts:23-37` — `readCursor` has no `FOR UPDATE`
- `apps/reporting/src/consumer/runConsumerPass.ts:42-66` — one failing event rolls back the whole batch; watermark does not advance
- `apps/reporting/src/cli/catchUp.ts` — explicitly allowed to run while the worker is live

## What's wrong
Two workers (daemon + catch-up) can read the same cursor, both apply `transaction.captured` (+1 volume), both write the same new watermark. A poison-pill event blocks every later event until ops deletes it — those look "skipped."

## Why
Single-writer assumption, no row lock, catch-up was documented as safe.

## What it breaks
Inflated `merchant_daily_volume`. Stale rollups until a manual cursor move. FP-300 "shows up right in the reports" fails.

## Smallest fix
`SELECT … FOR UPDATE` on the cursor row at the start of the pass. Dead-letter a poison row and advance past it.
