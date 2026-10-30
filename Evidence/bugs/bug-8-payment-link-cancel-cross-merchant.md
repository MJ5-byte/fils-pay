# Bug 8 — Cancel payment link is not merchant-scoped

**Severity:** High · **Area:** Payment links · **Clue:** Finance group chat — *"I cancelled merchant B's payment link from merchant A's dashboard"*

## Where
- `apps/api/src/paymentLinks/cancel.ts:13-28` — `UPDATE … WHERE id = $1 AND status = 'active'` (no `merchant_id`)
- `apps/api/src/routes/paymentLinks.ts` — `assertOwnMerchant` only checks the path `:merchantId`, not that the link belongs to it

## What's wrong
Any authenticated merchant who knows another merchant's link UUID can cancel it via `DELETE /v1/merchants/{theirId}/payment-links/{victimLinkId}`.

## Why
The UPDATE is keyed only on link id. Ownership is never joined.

## What it breaks
Cross-tenant denial of payment. Merchant A's dashboard can kill Merchant B's live checkout.

## Smallest fix
Pass `merchantId` into `cancelPaymentLink` and add `AND merchant_id = $2` on both the UPDATE and the follow-up SELECT.
