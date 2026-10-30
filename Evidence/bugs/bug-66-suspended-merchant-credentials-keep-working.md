# Bug 66 — Suspending a merchant does not stop existing sessions or API keys

**Severity:** High · **Area:** Auth · **Source:** CODE-007, CODE-030

## Where
- Login is the only check: `apps/api/src/routes/auth.ts:60-64` requires `m.status = 'active'`
- `apps/api/src/auth/sessions.ts:89-93` — `lookupSession` joins `merchant_users` and does not look at `merchants.status`
- `apps/api/src/apiKeys/verify.ts:16-20` — `revoked_at IS NULL` only. `revoke_after` (migration 0056) is never read. Authorize checks `onboarding_status = 'approved'`; capture and void do not.

## What's wrong
A session issued while the merchant was active, and any API key that has not been revoked, keep working after `merchants.status` moves to suspended or closed. Bug 44 is the same hole for rotation: the old key is a second credential that also ignores status.

## Why
The status predicate was added to the login query and not to the two lookups every later request uses.

## What it breaks
Suspending a merchant does not stop captures, voids, exports, or webhook changes for up to the session TTL (12 h) and indefinitely for API keys.

## Smallest fix
Join `merchants` in `lookupSession` and `verifyApiKey` and reject anything other than `active`. Enforce `revoke_after` in `verifyApiKey`.
