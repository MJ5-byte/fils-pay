# Bug 54 — Large CSV export pagination drops rows that share a timestamp

**Severity:** High · **Area:** Exports · **Clue:** Handwritten — *"has anyone tried uploading a really large export?"* (same class: large export)

## Where
- `apps/api/src/transactions/exportCsv.ts:66-84` — cursor is `occurred_at > $cursor` only
- List query correctly uses `(occurred_at, id)` composite
- HTTP route currently loads the full set into memory (`buildTransactionsExportCsv`) — OOM at scale; the streaming helper is still wrong if wired

## What's wrong
All but one row with the same `occurred_at` vanish on the next page. Agent files say loading everything is intentional.

## Why
Cursor forgot the unique tiebreaker.

## What it breaks
Finance exports silently lose captures that share a millisecond (batch close, payment-link double-capture, etc.). Reconciliation vs scheme is short.

## Smallest fix
`(occurred_at, id) > ($cursorTs, $cursorId)`. Stream the HTTP route; do not hold the full result.
