# Bug 32 — `expire_holds.ts` deletes **all** holds when nothing is expired

**Severity:** Critical · **Area:** Scripts · **Clue:** HANDOVER — *"scripts/expire_holds.ts flips `active` to `expired` with one UPDATE. Holds are never deleted."*

## Where
- `scripts/expire_holds.ts:17-45` — SELECT expired ids, then `buildDelete("holds", { id: expiredIds })`
- `scripts/lib/sqlFilter.ts:9-10, 24-29` — empty array is skipped, so `WHERE` is omitted → `DELETE FROM holds`

## What's wrong
A quiet night (`expiredIds = []`) generates `DELETE FROM holds` with no predicate. Every hold row, including live authorizations, is removed. HANDOVER's "flip active → expired, never delete" is the opposite of the code.

## Why
Generic SQL builder treats empty `IN ()` as "no filter" instead of "match nothing."

## What it breaks
One cron run wipes the holds table. Capture still proceeds (Bug 17). Authorizations become untraceable.

## Smallest fix
If `expiredIds.length === 0`, skip the DELETE. In `buildWhere`, empty arrays should produce `AND FALSE`. Prefer `UPDATE holds SET status = 'expired' WHERE id = ANY($1)`.
