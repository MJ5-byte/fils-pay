# Bug 39 — Duplicate acquirer callbacks write duplicate notes (FP-201)

**Severity:** High · **Area:** Webhooks · **Clue:** Support FP-201 REOPENED — *"The 1.9.0 postmortem says this was fixed. It wasn't."*; HANDOVER — *"recorded in processed_events before they're applied"* (table does not exist)

## Where
- `apps/api/src/acquirer/callbacks.ts:37-50` — plain INSERT
- `db/migrations/0051_acquirer_callback_notes.sql` — explicitly **no** unique on `callback_id`
- Commit `bf66bf25` subject: "fix: callbacks are deduplicated now" (the ledger-note is a decoy; the unique index was never added)

## What's wrong
The bank sending the same callback twice creates two identical notes. There is no `processed_events` table. 1.9.0 claimed a fix; the migration comment is the opposite.

## Why
Dedupe was described, not implemented. `callback_id` is stored as data, not as a key.

## What it breaks
Fraud/clear notes appear twice. Support acts twice. Combined with Bug 38, an attacker can append forever.

## Smallest fix
`UNIQUE (callback_id)` + `INSERT … ON CONFLICT DO NOTHING`, return 200.
