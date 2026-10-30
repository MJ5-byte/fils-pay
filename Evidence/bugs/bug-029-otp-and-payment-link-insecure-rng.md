# BUG-029 — Insecure PRNG (Math.random) Used for OTP Generation and Payment Link Tokens

## 1. Summary

Both 6-digit merchant/admin OTP codes and 22-character public payment-link tokens are generated using non-cryptographic PRNG (Math.random) in shared utility functions, making codes and payment URLs predictable.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/api/src/lib/random.ts, apps/api/src/paymentLinks/create.ts
- Reachability: Reachable on OTP creation and payment link creation
- Original Contributors / Sources: Clue 'OTP implementation changed', ARCHITECTURE

## 3. Root Cause

A shared helper in `apps/api/src/lib/random.ts` uses `Math.random()` for `randomDigits` and `randomFromAlphabet`. Cryptographic randomness (`crypto.randomBytes` / `randomToken`) exists in `apps/api/src/lib/crypto.ts` but was bypassed during refactoring.

## 4. Affected Files and Functions

- `apps/api/src/lib/random.ts:1-16` — `randomDigits`, `randomFromAlphabet`
- `apps/api/src/auth/otp.ts` — merchant OTP
- `apps/api/src/adminAuth/otp.ts` — admin OTP
- `apps/api/src/paymentLinks/create.ts` — public payment-link token
- Contrast: `apps/api/src/lib/crypto.ts` (`randomToken`)

## 5. Expected Behavior

All security-sensitive identifiers and tokens (OTPs and payment tokens) must be generated using a CSPRNG (`crypto.randomBytes` or `crypto.randomInt`) with sufficient entropy.

## 6. Actual Behavior

OTP codes use `Math.floor(Math.random() * 10**n)`. Payment-link tokens choose 22 characters from a 32-character alphabet using `Math.random()`. The PRNG state can be determined from observed outputs.

## 7. Trigger Conditions

Generation of any merchant login OTP, admin login OTP, or public payment link.

## 8. Technical Evidence

- `apps/api/src/lib/random.ts:1-16` — `randomDigits`, `randomFromAlphabet`
- `apps/api/src/auth/otp.ts` — merchant OTP
- `apps/api/src/adminAuth/otp.ts` — admin OTP (docblock claims `crypto.randomInt`; it does not)
- `apps/api/src/paymentLinks/create.ts` — 22-char public link token

Payment-link token generation:
- `apps/api/src/paymentLinks/create.ts` — token from `randomFromAlphabet`
- `apps/api/src/lib/random.ts:10-15`
- Secure alternative already exists: `apps/api/src/lib/crypto.ts` (`randomToken`)

Code snippet:
```ts
export function randomFromAlphabet(alphabet: string, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return result;
}
```

## 9. Runtime Evidence

No runtime reproduction artifact exists; statically confirmed via code review of `apps/api/src/lib/random.ts`.

## 10. Security / Financial / Functional Impact

Predictable OTPs enable second-factor bypass and account takeover. Predictable payment-link tokens allow unauthenticated attackers to discover and manipulate active payment links across merchants.

## 11. Safe Reproduction

Generate sequential outputs of `randomDigits` and `randomFromAlphabet` and observe reliance on V8 Math.random PRNG.

## 12. Related Findings

Consolidates legacy Bug 3 and Bug 9. Related to Bug 4 (OTP attempt limit race) and Bug 5 (token rotation).

## 13. Documentation Contradictions

ARCHITECTURE claims payment-link tokens are 128-bit tokens from `crypto.randomBytes`. Admin OTP docblock claims to use `crypto.randomInt`. Code contradicts both.

## 14. Recommended Remediation

Replace `Math.random` in `apps/api/src/lib/random.ts` with `crypto.randomInt`. Use `randomToken` from `apps/api/src/lib/crypto.ts` for payment-link tokens.

## 15. Remaining Questions and Limitations

None; Math.random is unambiguously non-cryptographic.

## 16. Original Reports Merged

`bug-3-otp-insecure-rng.md`, `bug-9-payment-link-token-insecure-rng.md`

## 17. Evidence References

`apps/api/src/lib/random.ts`, `apps/api/src/paymentLinks/create.ts`, `apps/api/src/lib/crypto.ts`
