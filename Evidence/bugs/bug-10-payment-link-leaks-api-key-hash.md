# Bug 10 — Public payment-link read leaks a live API key hash

**Severity:** High · **Area:** Payment links · **Clue:** Architecture security section (public checkout must not expose auth material)

## Where
- `apps/api/src/paymentLinks/read.ts:18-56` — unauthenticated `GET /v1/payment-links/:token`
- Lateral join selects `ak.key_hash AS integration_id` and `ak.key_prefix AS merchant_public_key`

## What's wrong
The public checkout payload includes the SHA-256 of a live merchant API key (`merchantIntegrationId`) plus the key prefix. The in-file comment claims no auth material beyond display name.

## Why
A join meant for "which integration created this link" was serialized into the DTO.

## What it breaks
Offline cracking / targeted attacks against merchant API keys from a URL that is emailed to buyers.

## Smallest fix
Drop the `api_keys` join and the `merchantPublicKey` / `merchantIntegrationId` fields from the public DTO.
