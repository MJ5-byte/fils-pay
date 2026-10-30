# Bug 15 — Merchant A can refund merchant B's transaction

**Severity:** Critical · **Area:** Refunds · **Clue:** Handwritten note — *"some admin actions don't seem to have the right role checks"* (same class: missing tenant check); `initiateMerchantRefund.test.ts` even notes the missing test

## Where
- `apps/api/src/refunds/initiateMerchantRefund.ts:62-78`

```ts
SELECT id, merchant_id FROM transactions WHERE id = $1
// then processRefund(..., merchantId: txn.merchant_id)  // victim's id, not caller's
```

Never compares `txn.merchant_id` to `input.merchantId`.

## What's wrong
Knowing a transaction UUID is enough to refund it as that merchant. Once Bug 12 is wired, this is a live IDOR.

## Why
Lookup is global; the caller's merchant is unused after `assertRefundsNotOnHold`.

## What it breaks
Cross-tenant money movement. Combined with Bug 1, a pending-session attacker can refund other shops.

## Smallest fix
If `txn.merchant_id !== input.merchantId`, throw `NotFoundError` (do not leak existence).
