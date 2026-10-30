# Bug 16 — Void does not reverse the acquirer authorization

**Severity:** High · **Area:** Payments · **Clue:** HANDOVER holds section; Architecture authorize/capture/void

## Where
- `apps/api/src/payments/void.ts:31-34, 66-79` — local `transactions` + `holds` only; comment says no acquirer call
- `apps/api/src/acquirer/types.ts` — no `void` / `reverseAuthorization` on the interface

## What's wrong
Void marks the payment voided in FilsPay. The issuer-side hold remains until it lapses. Combined with payment-link capture failure (Bug 7), customers keep blocked funds after we told them the payment was cancelled.

## Why
Acquirer client was never given a reverse method; void was implemented as a local state change.

## What it breaks
Cardholder funds stay held. Chargebacks / complaints. Dashboard lies.

## Smallest fix
Add `reverseAuthorization` to the acquirer client and call it from `voidTransaction` **before** marking voided. On acquirer failure, do not locally void.
