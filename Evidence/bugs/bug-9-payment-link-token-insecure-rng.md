# Bug 9 — Payment-link token is generated with `Math.random`

**Severity:** High · **Area:** Payment links · **Clue:** Architecture — *"Tokens are 128-bit, from `crypto.randomBytes`."*

## Where
- `apps/api/src/paymentLinks/create.ts` — token from `randomFromAlphabet`
- `apps/api/src/lib/random.ts:10-15`
- Secure alternative already exists: `apps/api/src/lib/crypto.ts` (`randomToken`)

## What's wrong
Public checkout URLs are 22 characters from a 32-char alphabet, each character chosen with `Math.random()`. Guessing a live link yields both the public read (Bug 10) and the pay endpoint (Bugs 6–7).

## Why
Shared non-crypto helper. Architecture's 128-bit `crypto.randomBytes` claim is not what the code does.

## What it breaks
Unauthenticated attackers can enumerate / predict payment links and pay (or cancel, via Bug 8) invoices they should never see.

## Smallest fix
`token = randomToken(16)` (or `crypto.randomBytes` encoded). Keep the DB unique constraint as a backstop, not the entropy source.
