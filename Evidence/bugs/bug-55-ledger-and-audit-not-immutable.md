# Bug 55 — Ledger groups and admin audit rows can be updated or deleted

**Severity:** High · **Area:** Ledger / audit · **Clue:** Architecture — *"The ledger is the record of money movements. Corrections are new entries."*

## Where
- `db/migrations/0007_ledger_double_entry.sql:67-74` — trigger enforces **balance** on UPDATE/DELETE of a group, not append-only. A balanced UPDATE/DELETE succeeds.
- `apps/api/src/adminAudit/log.ts:103-114` — `markAdminAuditOutcome` UPDATEs rows; no immutability trigger (comment claims one)

## What's wrong
Money history and admin audit are mutable. Architecture's "corrections are new entries" is not enforced.

## Why
The trigger was written to keep books balanced, not to keep them honest.

## What it breaks
An operator (or a bug, or Bug 32's style of script) can rewrite the past without a compensating entry. Auditors cannot trust either table.

## Smallest fix
`BEFORE UPDATE OR DELETE` on `ledger_entries` always RAISE. Audit: append-only outcome events, or forbid UPDATE except filling NULL columns once.
