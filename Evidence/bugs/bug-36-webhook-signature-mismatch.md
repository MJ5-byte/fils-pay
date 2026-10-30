# Bug 36 — Webhook HMAC is not over the bytes on the wire (FP-240)

**Severity:** High · **Area:** Webhooks · **Clue:** Support FP-240 — *"The part that signs the message and the part that sends it don't agree on what it looks like."*; HANDOVER — *"`ya/sign-raw` has a change for this; not merged."*; Yousif transmissions: sign the exact bytes we send

## Where
- `apps/api/src/webhooks/sign.ts:31-38` — HMAC over `canonicalJson(payload)` (sorted keys)
- `apps/api/src/webhooks/dispatcher.ts:158-172` — POST body is `JSON.stringify(row.payload)` (insertion order from Postgres/JS)
- Same split in `apps/api/src/webhooks/testSend.ts`

## What's wrong
Merchants who verify the raw HTTP body against `t=,v1=` get a mismatch even when the secret is correct. YA's unmerged `ya/sign-raw` was the fix: sign the exact bytes that `transport` sends.

## Why
Canonical JSON was used for idempotency-style stability; the body was never switched to that string.

## What it breaks
Shops reject genuine webhooks. Retries look randomly invalid. FP-300 "the shop gets the right webhook" cannot pass.

## Smallest fix
`const body = canonicalJson(row.payload)` (or `JSON.stringify` once); HMAC that string; send that string. Do not re-serialize.
