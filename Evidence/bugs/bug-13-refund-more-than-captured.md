# Bug 13 — Refunds are capped at authorized amount, not captured amount

**Severity:** Critical · **Area:** Refunds · **Clue:** Handwritten note — *"can you refund more than what was actually charged?"*

## Where
- `apps/api/src/payments/processRefund.ts:86-90`

```ts
const refundableFils = subtractFils(amountAuthorized, refundedFils);
```

- `apps/api/src/payments/refundValidation.ts` validates against the `refundableFils` it is given
- `packages/money` `calculateRefundFee` scales fee with no captured cap

## What's wrong
A payment authorized at 10_000 fils and captured at 4_000 fils can be refunded up to 10_000. Fee reversal can exceed the fee that was actually charged.

## Why
Ceiling uses `amount_fils` (the original authorization) instead of `captured_fils`.

## What it breaks
Money leaves the platform that never arrived. Partial captures become a free over-refund.

## Smallest fix
`refundableFils = subtractFils(capturedFils, refundedFils)`. Cap fee reversal at the capture-time fee.
