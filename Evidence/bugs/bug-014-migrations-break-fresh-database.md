# BUG-014 — Fresh Database Migrations Fail at 0054/0055 and View 0072 Has Broken Join Key

## 1. Summary

Fresh database migrations halt prematurely at 0054/0055 due to references to non-existent tables and mismatched schema column names, preventing downstream migrations (0056-0072) from running. Additionally, migration 0072 joins refunds to transactions on the wrong key.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Database and migrations
- Affected Component: db/migrate.ts, db/migrations/0054_views.sql, 0055_chart_of_accounts_suspense.sql, 0072_refund_merchant_summary.sql
- Reachability: Reachable on clean setup / docker compose up
- Original Contributors / Sources: YA last words, clean-migrate.txt, CODE-013

## 3. Root Cause

Migration `0054_views.sql` references non-existent table `settlement_batch_events`. Migration `0055_chart_of_accounts_suspense.sql` specifies column names `(code, name, account_type, description)` which do not match table `chart_of_accounts` schema `(id, name, kind)`. Migration `0072_refund_merchant_summary.sql` incorrectly joins `JOIN transactions t ON t.id = r.id` instead of `r.transaction_id`.

## 4. Affected Files and Functions

- `db/migrate.ts:36-52` — migration runner
- `db/migrations/0054_views.sql:10-22`
- `db/migrations/0055_chart_of_accounts_suspense.sql:3`
- `db/migrations/0072_refund_merchant_summary.sql:13-14`
- Affected downstream migrations: 0058 (live_sessions), 0060 (credits), 0070-0072 (refunds)

## 5. Expected Behavior

Running `npm run migrate` on a fresh database should apply all migrations cleanly in order from 0001 through 0072.

## 6. Actual Behavior

Migration runner throws `relation settlement_batch_events does not exist` at 0054 and rolls back. Downstream migrations never execute. If 0072 were executed, the materialized view would produce empty or invalid data.

## 7. Trigger Conditions

Running database migrations on any clean database instance, Docker Compose startup, or CI/CD pipeline.

## 8. Technical Evidence

- `db/migrations/0054_views.sql:10-22` — `v_unbatched_capture_events` references `settlement_batch_events`, a table **no migration creates**
- `db/migrations/0055_chart_of_accounts_suspense.sql:3` — `INSERT INTO chart_of_accounts (code, name, account_type, description)` but 0007 is `(id, name, kind)`
- `db/migrations/0072_refund_merchant_summary.sql:14` — `JOIN transactions t ON t.id = r.id` should be `r.transaction_id`
- `db/migrate.ts:36-52` — stops at the first failure
- Numbering gaps (abandoned): 0039, 0041, 0059, 0062, 0063, 0067 — gaps themselves are fine (lexical sort); the **contents** of 0054/0055 are not

Evidence from Bug 65 on migration 0072:
```sql
FROM refunds r
JOIN transactions t ON t.id = r.id
```
(Should be `ON t.id = r.transaction_id`).

## 9. Runtime Evidence

Runtime reproduced and documented in `Evidence/runtime-artifacts/clean-migrate.txt`.

## 10. Security / Financial / Functional Impact

Fresh deployments, local Docker environments, and new database instances cannot boot or function. Endpoints depending on migrations 0058+ (auth live_sessions, refunds, credits) fail with 500 errors.

## 11. Safe Reproduction

Run `npm run migrate` against a clean PostgreSQL container and examine migration log output.

## 12. Related Findings

Consolidates legacy Bug 57 and Bug 65. Blocks Bug 12, Bug 67, and Docker Compose bringup.

## 13. Documentation Contradictions

Release notes and deployment documentation claim seamless fresh database setup; reality is a hard migration blocker.

## 14. Recommended Remediation

Fix 0054 to reference existing columns (`te.settlement_batch_id IS NULL`), fix 0055 column names `(id, name, kind)`, and fix 0072 join to `ON t.id = r.transaction_id`.

## 15. Remaining Questions and Limitations

None; reproduction log `clean-migrate.txt` records exact PostgreSQL error.

## 16. Original Reports Merged

`bug-57-migrations-break-fresh-database.md`, `bug-65-refund-summary-view-joins-wrong-id.md`

## 17. Evidence References

`db/migrate.ts`, `db/migrations/0054_views.sql`, `db/migrations/0055_chart_of_accounts_suspense.sql`, `db/migrations/0072_refund_merchant_summary.sql`, `Evidence/runtime-artifacts/clean-migrate.txt`
