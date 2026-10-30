# Bug 38 — Acquirer callbacks are accepted unsigned by default

**Severity:** High · **Area:** Webhooks · **Clue:** FP-240 incoming check; ARCHITECTURE outbound HMAC; `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default false

## Where
- `apps/api/src/config.ts` — `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults `false`
- `apps/api/src/webhooks/inboundVerify.ts:52-56` — missing header → `{ valid: true }` when not required
- Route does not validate `outcome` despite a comment claiming it does

## What's wrong
Anyone who can reach the callback URL can attach `confirmed_fraud` / `cleared` notes (and arbitrary `outcome` strings) to any transaction UUID.

## Why
A "dev convenience" default was left for production. Combined with Bug 37, requiring signatures would have broken real callbacks, so the flag stayed off.

## What it breaks
Timeline poisoning, false fraud flags, support acting on forged bank notes.

## Smallest fix
Default the flag to true in non-dev. Reject missing/invalid signatures. Allow only `cleared` | `confirmed_fraud`.
