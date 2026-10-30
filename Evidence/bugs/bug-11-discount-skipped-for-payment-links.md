# Bug 11 — Negotiated discount is not applied on payment-link captures

**Severity:** High · **Area:** Fees / payment links · **Clue:** Finance — fee shown vs charged; "looks easy. it isn't. it touches everything."

## Where
- `apps/api/src/paymentLinks/pay.ts:114-126` — calls `captureTransaction` only
- `apps/api/src/routes/transactions.ts` — API capture path then calls `applyCaptureDiscountAdjustment`
- `apps/api/src/payments/discountAdjustment.ts`

## What's wrong
Hosted-checkout pay never posts the discount adjustment ledger group. Merchants with `negotiated_discount_bps > 0` (e.g. Delta Marketplace) are charged full MDR on every payment-link capture, while direct `/v1/transactions` captures get the discount.

## Why
Discount lives in the HTTP route, not inside `captureTransaction`. Payment-link pay intentionally "never issuing an HTTP request back into the API's own /v1/transactions routes," so it skipped the side effect.

## What it breaks
Wrong fees, wrong merchant payable, wrong settlement vs dashboard. Combined with Bug 31 (TS vs Go fee formulas) the ledger and the batch never agree for discounted merchants.

## Smallest fix
Call `applyCaptureDiscountAdjustment` after a successful capture inside `payPaymentLink`, or move the adjustment into `captureTransaction`'s commit path so every caller gets it.
