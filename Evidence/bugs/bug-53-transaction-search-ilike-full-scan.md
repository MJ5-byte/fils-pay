# Bug 53 — Transaction search is `ILIKE '%…%'` with no trigram index

**Severity:** Medium · **Area:** Reporting / API · **Clue:** Handwritten — *"one of the reporting queries is suspiciously slow"*

## Where
- `apps/api/src/transactions/query.ts:96-113` — leading-wildcard ILIKE on `reference` and `acquirer_reference`

## What's wrong
Every search is a sequential scan per merchant. In-file comment already flags it.

## Why
"Just make find work" with a leading `%`.

## What it breaks
Dashboard search p95 blows up as volume grows. Can take the API with it (same pool as payments).

## Smallest fix
Prefix search (`ILIKE $q || '%'`) plus a `text_pattern_ops` index, or `pg_trgm` GIN if infix search is required.
