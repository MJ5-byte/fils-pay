# Fork mining baseline — 2026-10-30

Original HEAD: `c389b26` on `main`. Dedicated branch: `speedup/fork-mined-fixes`.
Initial working tree: only the user's untracked `Evidence/FORK_INTELLIGENCE_AND_ADAPTATION_REPORT.md`.
No existing human changes overwritten. Old agent instruction files were not read, per user instruction.

Read the complete fork report, architecture, handover, changelog, all six ADRs,
bugfix plan, bug registry, and the relevant per-issue evidence before changes.
The bugfix plan explicitly identifies stale architecture claims; verified code
and integer-fils/tenant-isolation invariants take precedence over those claims.

Baseline commands/results:

- `npm ci --cache .fork-tooling/npm-cache`: installed locked dependencies; lockfile unchanged.
- `npm run typecheck`: initially blocked by absent dependencies; passes after install.
- `npm test`: initially blocked by absent dependencies, then DB suites require `DATABASE_URL`.
- `go test ./...` in `apps/settlement`: passes with a writable workspace `GOCACHE`.
- `npm run migrate` against a newly initialized loopback-only PostgreSQL 16.9:
  fails at `0054_views.sql`, SQLSTATE 42P01, nonexistent `settlement_batch_events`.
- Schema inspection independently confirms 0055 uses nonexistent chart columns.
- Docker CLI absent. Browser runtime discovery returned no available browsers.

Artifacts: `fork-baseline-*.txt`, `fork-dependency-install.txt`.
Test cluster setup: `node Evidence/fork-runtime-setup.mjs`; verifies actual
data directory/address/port before creating the synthetic `fork_mining` database.
Prior investigation binaries are reused; its databases and state are not.
Local DB state, tooling cache and temporary original-source checkout stay in ignored `.fork-tooling/`.

## BATCH 0 RESULT

Issues investigated: dependency availability, migrations, TypeScript, Go, runtime tooling.
Issues reproduced: fresh migration boot failure (BUG-014).
Issues already fixed: none.
Issues not reproducible: none claimed.

Fixes applied:
1. 0054 uses the existing transaction-event settlement_batch_id.
2. 0055 inserts suspense accounts using actual id/name/kind columns.

Reference repositories inspected: sama-elsawaf/main focused auth history; ali-afk/main runtime history.
Files changed: .gitignore, db/migrations/0054_views.sql, db/migrations/0055_chart_of_accounts_suspense.sql, Evidence baseline/setup artifacts.
Migrations added: none in this batch.
Regression tests added: real migration-runner execution against empty PostgreSQL (artifact).
Commands run: npm ci, npm run typecheck, npm test, npm run migrate, go test ./....
Focused test result: migration runner reaches 0072 after repair.
Full TS result: typecheck passes; DB suite deferred until boot repair.
Go result: passes.
Docker/runtime result: PostgreSQL verified; Docker unavailable.
Evidence updated: this file, fork_mined_fixes.md.
Known failures: invalid development webhook-key fallback; refund/reporting defects remain for later batches.
Recommended next batch: Batch 1.

Historical migration exception: 0054 and 0055 cannot apply on the supplied schema;
a forward migration cannot repair a runner that stops before reaching it.
Only these two broken boot files were repaired in place. No applied production
database was accessed. All subsequent schema corrections use forward migrations.
