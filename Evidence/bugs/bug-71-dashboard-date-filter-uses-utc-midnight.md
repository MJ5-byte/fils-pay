# Bug 71 — Dashboard date filters start at UTC midnight, not Bahrain midnight

**Severity:** Medium · **Area:** Reporting / UI · **Source:** CODE-020b (comment vs code)

## Where
- `apps/web/src/format.ts:33-36`

```ts
// fixed, uses bahrain time now — am
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}
```

The `Z` is UTC. Settlement business days are Asia/Bahrain (UTC+3), 00:00 to the next 00:00.

## What's wrong
A merchant picking 30 Oct sends `2026-10-30T00:00:00.000Z`, which is 03:00 Bahrain. Transactions from 00:00 to 03:00 Bahrain on that date fall into the previous filter day. The comment on the previous line says this was fixed. The function still appends `Z`.

## Why
The amendment comment was added without changing the string.

## What it breaks
Dashboard totals for a calendar day do not match the settlement batch for that Bahrain day. The first three hours of every local day are missing from "today" and appear in "yesterday". This is the same three-hour slice as Bug 27, on the read side.

## Smallest fix
Return `${dateValue}T00:00:00.000+03:00` (or format the instant in `Asia/Bahrain`). Use one helper for every `from`/`to` filter.
