# Bug 18 — Capture holds a DB transaction open across the acquirer call

**Severity:** Medium · **Area:** Payments · **Clue:** FP-209 load-test notes; "Normal payments don't have this problem" (they have a different one)

## Where
- `apps/api/src/payments/capture.ts:77-178` — `withTransaction` + `FOR UPDATE` from validation through `await acquirer.capture(...)` until commit
- `apps/api/src/payments/authorize.ts:57-93` — the same pattern around `acquirer.authorize`

## What's wrong
One pool connection and a row lock are held for the full acquirer RTT, on both authorize and capture. Payment-link pay does both, so it holds two connections in sequence. When the pool (max 5) is busy, the next request does not hang: `connectionTimeoutMillis` defaults to 5 seconds (`config.ts`, `PG_POOL_CONNECTION_TIMEOUT_MS`) and the request fails.

## Why
The lock was added to prevent lost updates (the thing refunds forgot — Bug 14) but the acquirer call was left inside the same transaction.

## What it breaks
API-wide timeouts, lock contention, cascading 500s. Not a money-loss bug by itself, but it is why capture "doesn't have" the concurrent double-capture problem — at the cost of availability.

## Smallest fix
Short txn: lock, validate, record intent. Acquirer outside. Second txn applies the result (with the same `FOR UPDATE` guard). Do **not** copy refund's current pattern.
