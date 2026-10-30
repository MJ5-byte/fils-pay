# Bug 44 — API key "rotation" does not revoke the old key

**Severity:** High · **Area:** Admin / security · **Clue:** Handwritten — *"there's a key rotation flow that doesn't do what you'd expect"*

## Where
- `apps/api/src/admin/apiKeys.ts:31-46` — issues a new key with `rotatedFromKeyId`, never `UPDATE … SET revoked_at`
- `apps/api/src/apiKeys/issue.ts` — `revokeApiKey` exists and is unused on this path

## What's wrong
After rotation, both keys work. The audit row says `api_key_rotate`. The old secret remains valid indefinitely.

## Why
Rotation was implemented as "issue another key and remember the parent," not "replace."

## What it breaks
A leaked key that was "rotated" is still live. Incident response that relies on rotation does nothing.

## Smallest fix
In the same transaction, `UPDATE api_keys SET revoked_at = now() WHERE id = $oldId`.
