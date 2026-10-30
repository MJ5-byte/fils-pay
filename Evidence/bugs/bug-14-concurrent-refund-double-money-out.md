# Bug 14 — Concurrent refunds both succeed (FP-209)

**Severity:** Critical · **Area:** Refunds · **Clue:** Support ticket FP-209 — *"Two refund requests came in at the same time. Both went through, and we lost money. Normal payments don't have this problem."*

## Where
- `apps/api/src/payments/processRefund.ts:73-78, 141-203` — phase 1 reads `transactions` **without `FOR UPDATE`**, commits, calls the acquirer **outside** the DB txn, then writes `refunded_fils` from the **stale** snapshot
- Contrast: `apps/api/src/payments/capture.ts` holds `FOR UPDATE` (that path has the opposite problem — Bug 18)

## What's wrong
Two refunds with different idempotency keys on the same capture both read `refunded_fils = 0`, both pass validation, both hit the acquirer, both post ledger legs. The later UPDATE can even leave `refunded_fils` looking like a single refund.

## Why
Lost update. Capture locks the row through the acquirer call; refunds do not.

## What it breaks
Double (or N-way) money out. Ledger vs acquirer vs `refunded_fils` diverge.

## Smallest fix
`SELECT … FOR UPDATE` in phase 1; reserve a pending refund amount before the acquirer call; phase 3 use `refunded_fils = refunded_fils + $2` with `refunded_fils + $2 <= captured_fils`.
