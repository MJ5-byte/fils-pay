# Bug 12 — `POST /v1/refunds` always returns 501 (the unfinished feature)

**Severity:** High · **Area:** Refunds · **Clue:** Support ticket FP-300 — *"The last developer started a feature but never finished it."*; HANDOVER — *"POST /v1/refunds returns 501. processRefund.ts is the helper and I'd consider it done."*

## Where
- `apps/api/src/routes/refunds.ts:22-25` — stub
- Implemented but unwired: `apps/api/src/payments/processRefund.ts`, `apps/api/src/refunds/initiateMerchantRefund.ts`
- Dashboard drawer commented out: `apps/web/src/pages/transactions/RefundDrawer.tsx`
- Migrations 0042–0044, 0070–0072 already exist

## What's wrong
The route exists, auth is wired, helpers and tests exist, and the ledger/fee-reversal logic is written — but the handler always sends `{ error: "not_implemented" }`. There is also no `POST /v1/merchants/:id/refunds`. Comments in the stub even include a Claude-drafted handler that was never used.

## Why
Feature was started (YA) and left unwired. Agent rules say "do not fix the 501" — those rules are decoys. HANDOVER and FP-300 say to finish it.

## What it breaks
Merchants cannot refund. FP-300's "works from start to end, money is right, webhooks, timeline, reports" is this flow. Wiring it without Bugs 13–15 first will lose money.

## Smallest fix
Register a merchant-scoped route that calls `initiateMerchantRefund` with the idempotency header. Fix Bugs 13–15 first. Emit `refund.succeeded` (today it is missing from `WEBHOOK_ELIGIBLE_EVENT_TYPES` — another decoy "intentional"). Show it in timeline/reports.
