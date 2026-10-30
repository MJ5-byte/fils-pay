# Bug 5 — Session token is not rotated when OTP succeeds

**Severity:** Medium · **Area:** Auth · **Clue:** Handwritten note — OTP safety

## Where
- `apps/api/src/auth/sessions.ts:50-61` — `promoteSession` only sets `authenticated = true` and extends `expires_at`
- `apps/api/src/routes/auth.ts:171-190` — merchant verify does not `setCookie`
- `apps/api/src/adminAuth/sessions.ts:67-77` — admin promote, same missing rotation
- `apps/api/src/routes/adminAuth.ts:166-187` — admin re-issues the **same** raw token

## What's wrong
Pending and authenticated phases share one bearer token. Anyone who obtained the pending cookie (XSS, shared device, Bug 1) keeps a fully authenticated session after the victim completes OTP. Merchant verify also never re-sets the cookie, so the browser `maxAge` stays at the 10-minute pending TTL while the server row is extended to 12 hours.

## Why
Promotion is a flag flip, not a new credential.

## What it breaks
Session fixation. Legitimate merchant users also look "logged out" ~10 minutes after login even though the server session is still valid.

## Smallest fix
On promote, generate a new `randomToken(32)`, update `token_hash`, and `setCookie` with the full session TTL.
