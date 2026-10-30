# Bug 37 — Inbound acquirer HMAC is over re-serialized JSON, not raw bytes

**Severity:** High · **Area:** Webhooks · **Clue:** FP-240 — *"someone said the incoming signature check has its own problems."*

## Where
- `apps/api/src/webhooks/inboundVerify.ts:40-66`
- `apps/api/src/routes/acquirerCallbacks.ts`

## What's wrong
Verifier does `HMAC(timestamp + "." + JSON.stringify(parsedObject))`. The acquirer signed the raw body. Key order, spacing, and number formatting differ after Fastify parses JSON. Timestamp is parsed and **never** checked for freshness. Compare uses `Buffer.compare` on decoded bytes, not `timingSafeEqualHex`.

## Why
Sign-the-object instead of sign-the-bytes, copied from the outbound bug in reverse.

## What it breaks
Legitimate signed callbacks fail (so ops turns the check off — Bug 38). Replays of old callbacks succeed when a signature is present.

## Smallest fix
HMAC `${timestamp}.${rawBody}`. Enforce a max age on `t=`. Use `timingSafeEqualHex`.
