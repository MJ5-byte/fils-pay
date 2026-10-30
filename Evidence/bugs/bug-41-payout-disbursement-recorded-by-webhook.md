# Bug 41 — Payout disbursement is recorded by the webhook dispatcher

**Severity:** High · **Area:** Payouts · **Clue:** Incident 2026-08-21 follow-on; migration 0057 comment "one row per paid batch"

## Where
- `apps/api/src/webhooks/dispatcher.ts:37-41, 160-163` — `PRE_DELIVERY_EFFECTS['settlement.paid']` runs when `attempt_count === 0`
- `apps/api/src/webhooks/payoutDisbursement.ts` — plain INSERT, no unique on `settlement_batch_id`
- `db/migrations/0057_settlement_payout_disbursements.sql`

## What's wrong
A money-side-effect (we recorded a bank disbursement) is triggered by **attempting** to tell the merchant. One outbox event × N endpoints = N rows. Replays mint a new delivery with `attempt_count === 0` again (Bug 42). The Go `PayoutBatch` path that should own this does not.

## Why
Side effect was bolted onto first delivery to "keep it in one place."

## What it breaks
Ops sees multiple disbursements per batch. Finance thinks we paid twice. A failed webhook can still have recorded a payout — or a successful payout can be recorded twice.

## Smallest fix
Record disbursement inside `PayoutBatch` only. Remove the dispatcher effect. `UNIQUE (settlement_batch_id)`.
