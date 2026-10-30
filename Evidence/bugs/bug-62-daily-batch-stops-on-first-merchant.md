# Bug 62 — One failing merchant stops the daily close for everyone after them

**Severity:** Medium · **Area:** Settlement · **Source:** CODE-026

## Where
- `apps/settlement/internal/settlement/batch.go:427-439` — merchants are sorted by id, then `CloseBatch` / `PayoutBatch` errors return from `RunDailyBatch` immediately
- `apps/settlement/internal/scheduler/daemon.go:92-95` — the daemon logs that error and waits for the next 60 s tick, which starts the same loop again

## What's wrong
`ErrMerchantNotEligible` is skipped. Every other error aborts the function. Merchants later in id order are not closed or paid on that tick. The failing merchant is still first among those not yet done, so the same error blocks the tail on every tick until someone fixes that merchant.

## Why
The loop treats one merchant's failure as a failure of the whole day.

## What it breaks
A single bad fee schedule, lock timeout, or data error holds payout for every merchant sorted after it.

## Smallest fix
Record the merchant error on the report and continue. Alert on the failed id. Do not `return` out of the loop.
