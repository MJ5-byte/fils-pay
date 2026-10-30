# Bug 3 — OTP codes and payment-link tokens use `Math.random`

**Severity:** High · **Area:** Auth / Payments · **Clue:** Handwritten note — *"the OTP implementation changed at some point. is it still safe?"*; stickers — "refactored it properly finally"

## Where
- `apps/api/src/lib/random.ts:1-16` — `randomDigits`, `randomFromAlphabet`
- `apps/api/src/auth/otp.ts` — merchant OTP
- `apps/api/src/adminAuth/otp.ts` — admin OTP (docblock claims `crypto.randomInt`; it does not)
- `apps/api/src/paymentLinks/create.ts` — 22-char public link token

## What's wrong
OTP codes are `Math.floor(Math.random() * 10**n)`. Payment-link tokens are drawn from an alphabet with the same PRNG. A CSPRNG (`crypto.randomBytes` / `randomToken`) already exists in `apps/api/src/lib/crypto.ts` and is used for session tokens.

## Why
A later refactor moved generation into a shared helper and dropped cryptographic randomness. Agent instruction files claim this is "intentional"; those files are decoys. Architecture says tokens are 128-bit from `crypto.randomBytes`.

## What it breaks
6-digit OTPs (and public pay URLs) are predictable / brute-forceable. Combined with Bug 4 (attempt limit race) and Bug 5 (resend resets the budget), the second factor is not a second factor.

## Smallest fix
Implement `randomDigits` / `randomFromAlphabet` with `crypto.randomInt`. Use `randomToken` for payment-link tokens.
