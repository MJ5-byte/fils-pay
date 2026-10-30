# Bug 17 — Capture ignores hold expiry (and the janitor deletes the hold)

**Severity:** High · **Area:** Payments · **Clue:** HANDOVER — *"Holds are never deleted."* (they are); Architecture capture must honour the authorization window

## Where
- `apps/api/src/payments/capture.ts:119-151` — captures under a transaction row lock; never reads `holds.status` / `holds.expires_at`
- `apps/api/src/payments/authorize.ts` — hold `expires_at = now() + 7 days`
- `scripts/expire_holds.ts` — **DELETE**s expired active holds; the transaction stays `authorized`

## What's wrong
A capture of a 8-day-old authorization succeeds locally. After the nightly janitor, there is not even a hold row, and capture still succeeds. Architecture and HANDOVER say holds are flipped to `expired`, never deleted.

## Why
Capture is keyed only on `transactions`; the hold is a side table that nothing consults at capture time.

## What it breaks
Captures against dead authorizations. Ledger with no matching hold. Real acquirer may decline or post a late capture the issuer will dispute.

## Smallest fix
Under the row lock, join `holds` and reject if missing, not `active`, or `expires_at <= now()`. Janitor should `UPDATE holds SET status = 'expired'` **and** expire the transaction, not DELETE (see Bug 32).
