# Bug 6 — Payment link can be paid after it expired (FP-187)

**Severity:** Critical · **Area:** Payment links · **Clue:** Support ticket FP-187 — *"The checkout page sends something that the server shouldn't trust."*

## Where
- `apps/api/src/paymentLinks/pay.ts:34-37, 60, 73-75` — `expiryReferenceTime(submittedAt)`
- `apps/api/src/routes/paymentLinks.ts:34-37, 155-166` — public pay forwards body `submittedAt` (comment says ignore unless API-key auth; it does not)
- `apps/web/src/pages/checkout/CheckoutPage.tsx:59-63` — honest checkout sends client clock

## What's wrong
Expiry is evaluated against attacker-controlled `submittedAt`, not server time. `GET` uses the server clock (link shows "expired"); `POST …/pay` accepts a timestamp from before `expires_at`.

## Why
A public, unauthenticated endpoint trusts a client-supplied clock "so a retry after midnight is not penalised."

## What it breaks
Expired invoices stay payable forever. A buyer (or anyone with the token) backdates `submittedAt` and is charged.

## Smallest fix
On the public pay route, ignore `submittedAt` (always `new Date()`). If offline terminals need it, put it on a separate authenticated route and clamp to a short server-side window.
