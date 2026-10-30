# Bug 61 — Closing a settlement day freezes it, including today and the future

**Severity:** High · **Area:** Settlement · **Source:** CODE-026

## Where
- `apps/api/src/routes/admin.ts:109-123` — `POST /v1/admin/settlement/run-batch` checks that `date` matches `YYYY-MM-DD` and nothing else
- `apps/settlement/internal/settlement/batch.go:93-111` — a batch that is not `open` is a no-op. Nothing reopens it.

## What's wrong
Finance or super_admin can close today, or a future date. `CloseBatch` inserts the batch, finds whatever captures already exist in that Bahrain window (often none), and freezes it. Later captures in the same window keep `settlement_batch_id` NULL. The next daemon tick and every manual re-run see a non-open batch and skip them.

## Why
"Re-run is safe" in the runbook assumes a closed day can be recomputed. The code treats closed as final and does not check that the day has ended.

## What it breaks
A premature run drops the rest of that day's money out of settlement forever. Between 00:00 and 03:00 Bahrain the daemon itself targets the wrong date (Bug 27); a manual run of "today" does the same damage on purpose.

## Smallest fix
Reject any date that is not a completed Bahrain business day. Do not insert a batch row until there is something to close, or leave the row `open` until the window has ended.
