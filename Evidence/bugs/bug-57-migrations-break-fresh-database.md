# Bug 57 — Fresh-database migrations stop at 0054/0055; later schema never applies

**Severity:** Critical · **Area:** Schema / hosting · **Clue:** YA last words — *"His fixes still exist: … the abandoned migrations"*; `db/migrate.ts:85` FH: *"numbering gaps make this fail on a fresh DB?"*; FP-300 Dilmune Cloud

## Where
- `db/migrations/0054_views.sql:10-22` — `v_unbatched_capture_events` references `settlement_batch_events`, a table **no migration creates**
- `db/migrations/0055_chart_of_accounts_suspense.sql:3` — `INSERT INTO chart_of_accounts (code, name, account_type, description)` but 0007 is `(id, name, kind)`
- `db/migrations/0072_refund_merchant_summary.sql:14` — `JOIN transactions t ON t.id = r.id` should be `r.transaction_id`
- `db/migrate.ts:36-52` — stops at the first failure
- Numbering gaps (abandoned): 0039, 0041, 0059, 0062, 0063, 0067 — gaps themselves are fine (lexical sort); the **contents** of 0054/0055 are not

## What's wrong
On a clean Postgres, 0054 errors `relation settlement_batch_events does not exist`, the runner rolls back, and 0056–0072 never apply. That includes `live_sessions` (0058, Bug 1), credits (0060), and refunds (0070–0072). Reproduced in `Evidence/runtime-artifacts/clean-migrate.txt`.

## Why
0054/0055 were written against a staging-branch schema (YA's abandoned PRs) and merged into main anyway.

## What it breaks
`docker compose up` and any Dilmune Cloud deploy: login 500s, credits missing, refunds missing. FP-300 cannot ship until this chain applies.

## Smallest fix
- 0054: rewrite the view with `te.settlement_batch_id IS NULL` (column that exists), or drop the unused view.
- 0055: `INSERT INTO chart_of_accounts (id, name, kind) VALUES ('suspense', 'Suspense', 'liability') ON CONFLICT DO NOTHING;`
- 0072: `JOIN transactions t ON t.id = r.transaction_id`
- Do **not** edit already-applied files on an existing DB; add follow-up migrations if needed. On a fresh DB these three files can be corrected in place because they never applied.
