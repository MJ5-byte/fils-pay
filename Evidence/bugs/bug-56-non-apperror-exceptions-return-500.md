# Bug 56 — `RangeError` and bad UUIDs become HTTP 500

**Severity:** Medium · **Area:** API · **Clue:** Architecture error handling; money `toFils` throws `RangeError`

## Where
- `apps/api/src/plugins/errorHandler.ts:16-35` — only `AppError` is mapped
- `packages/money/src/fils.ts:35-44` — `toFils(1.5)` throws `RangeError`
- Invalid UUID path params hit Postgres `22P02` → unhandled

## What's wrong
Client mistakes look like outages. Idempotent clients retry 500s and can double-submit (Bugs 7, 14).

## Why
Error handler only knows the in-house hierarchy.

## What it breaks
Noise in on-call, retries that move money twice.

## Smallest fix
Map `RangeError` → 400. Validate UUIDs before the query. Map `pg` `22P02` to 400.
