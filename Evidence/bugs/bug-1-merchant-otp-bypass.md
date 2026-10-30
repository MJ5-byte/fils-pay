# Bug 1 — Merchant login works without entering the OTP

**Severity:** Critical · **Area:** Auth · **Clue:** Finance group chat — *"Login works without entering the OTP code?"*; handwritten note — *"the OTP implementation changed at some point. is it still safe?"*

## Where
- `apps/api/src/auth/sessions.ts:78-103` — `lookupSession`
- `db/migrations/0058_live_sessions.sql:3-12` — `live_sessions` view
- `apps/api/src/routes/auth.ts:87-105` — pending cookie issued after password only
- Contrast: `apps/api/src/adminAuth/sessions.ts` still requires `authenticated = true`

## What's wrong
`POST /v1/auth/login` checks the password, then sets `fp_sid` to a **pending** session (`authenticated = false`). Every protected merchant route resolves that cookie through `lookupSession`, which reads `live_sessions`. The view filters only `revoked_at IS NULL AND expires_at > now()`. Nothing checks `authenticated = true`.

## Why
Migration 0012 states every authenticating query must include `authenticated = true`. Migration 0058 replaced the direct `sessions` query with a view and dropped that predicate. The admin plane kept the check; the merchant plane lost it.

## What it breaks
The second factor protects nothing. With only a stolen password, an attacker calls `/login`, keeps the cookie, and has a full session for 10 minutes — including owner-only actions such as minting a live API key.

## Smallest fix
Add `AND authenticated = true` to `lookupSession` (or to the `live_sessions` view). Add a regression test that a pending cookie gets 401 on `/v1/auth/me`.
