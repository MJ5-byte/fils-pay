# FilsPay — Runtime & Security Investigation

Investigation opened: **2026-10-30 10:43 Asia/Bahrain (UTC+03:00)**. Exact command timestamps are retained in the evidence log and artifacts.

Branch: `main`  
Commit: `3ac53d485e536d8179a9e3a2a5f9f11eb5f8a9ef`

## 1. Executive Summary

Investigation in progress. This is an independent verification of prior reports and the current repository, not an implementation or repair task. No runtime vulnerability is considered reproduced without an executed, recorded reproduction. Static conclusions, hypotheses, failed attempts, and blockers are distinguished throughout.

Scope: API, merchant and admin frontends, settlement service, reporting worker, money/events packages, scripts, database schema/seeds, deployment material, documentation, and Git/forensic evidence. Prior findings will be individually reassessed.

## 2. Investigation Environment

- Workspace: `C:\Users\hanwd\OneDrive\Desktop\fils-pay`.
- Windows; PowerShell `5.1.26100.9818`; user timezone Asia/Bahrain.
- Node/npm, Go, and Git found on PATH. Docker and psql not found on PATH during initial inspection. The Python command resolves to a WindowsApps alias and has not yet been verified.
- Initial Git status: `?? Evidence/DOCS_FULL_INVESTIGATION.md` (pre-existing; do not overwrite).
- No application execution has occurred at opening.

## 3. Safety and Isolation Verification

Isolation verified at 2026-10-30 10:56:34 +03:00: EVID-005, [isolation.json](runtime-artifacts/isolation.json). PostgreSQL 16.9 binds only 127.0.0.1:62998 using a newly initialized temporary data directory. Synthetic local role has no password. All children receive explicit local URLs and whitelisted environments, excluding ambient PG settings and credentials. No production/shared database, real processor, bank transfer, external merchant endpoint, or purported production dump is used. Only new Evidence files persist in the repository. Windows launcher and initial harness-guard failures remain recorded.

## 4. Application Startup Results

The normal stack has NOT started successfully. Docker is absent and both referenced Dockerfiles are missing. Dependencies installed in the temporary checkout; PostgreSQL 16.9 runs only on loopback. The unmodified migration runner fails at 0054 (EVID-006; [clean-migrate.txt](runtime-artifacts/clean-migrate.txt)).

An explicitly separate partial-schema database was prepared for independent service tests (EVID-007). Failed migrations are recorded in [partial-schema.json](runtime-artifacts/partial-schema.json). Service boot/build results will be added next. This fixture does not repair or validate the normal startup path.

## 5. Evidence Collection Log

### EVID-001 — Baseline and preservation

**Timestamp:** 2026-10-30 10:42–10:43 Asia/Bahrain.  
**Source:** `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, file inventory, command discovery.  
**Related finding:** Environment/preservation baseline.  
**Status:** Observed.

**Observed:** Branch `main`; HEAD `3ac53d485e536d8179a9e3a2a5f9f11eb5f8a9ef`. Sole pre-existing untracked path is `Evidence/DOCS_FULL_INVESTIGATION.md`. No tracked modifications reported. Node/npm, Go, Git are available. Docker and psql did not resolve through `Get-Command`.

**Commands:**

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
rg --files -g '!node_modules' -g '!.git'
Get-ChildItem -LiteralPath Evidence -Recurse -File | Select-Object FullName,Length
Get-Command go,docker,node,npm,python,psql,git -ErrorAction SilentlyContinue | Select-Object Name,Source
```

**Conclusion:** Preserve existing report and all project contents. Establish isolation before application/database testing.

### EVID-002 — Prior reports read; original IDs preserved; safe runtime copy prepared

**Timestamp:** 2026-10-30 10:48:57 +03:00.

**Status:** Observed / static-only. Read the complete prior documentation report, Git/comment dossier (including comment inventory), forensic story, messages, archived instruction files, and commit inventory. The latter's source-comment appendix duplicates the dossier; automated comparison is in [prior-inventory-check.json](runtime-artifacts/prior-inventory-check.json).

All 32 original findings were extracted without renumbering into section 6 and [findings.json](runtime-artifacts/findings.json). Prior reports make static and snapshot claims, not runtime verification. The documentation report cites HEAD `6d7cfb6`; this investigation is pinned to the different current HEAD stated above.

[baseline-manifest.json](runtime-artifacts/baseline-manifest.json) records SHA-256 and byte sizes of all tracked files and the pre-existing untracked report. A temporary source copy was prepared at `C:\Users\hanwd\AppData\Local\Temp\filspay-forensic-euGZtR\checkout`; source bytes were copied without edits. Committed environment files, the purported production SQL dump, all docs/exports, and prior Evidence were excluded. No application, test, migration or seed was executed by this preparation. Dependency/build/runtime output will remain in the temporary directory.

**Initial static observations:** `ops/Dockerfile.node` and `ops/Dockerfile.go` are absent. `apps/settlement/internal/config/config.go:72-74` makes `PGCONN_SETTLEMENT` override `DATABASE_URL`. API, reporting, seeds and scripts use explicit `DATABASE_URL`; pg connection defaults may also be inherited if not cleared, so runtime child processes receive a whitelist of environment variables. No live connection target or secret values were printed or retained.

**Command:** `node Evidence/runtime-artifacts/investigate.mjs init`.

### EVID-003 — Independent startup review finds an accounting-control contradiction

**Timestamp:** 2026-10-30 10:53:23 +03:00.

**Status:** Static-only; runtime test pending. **New lead NEW-001 (High):** contrary to the previous documentation report's claim of ledger immutability, `db/migrations/0007_ledger_double_entry.sql:39-74` installs a deferred balance check, not a prohibition on UPDATE/DELETE. Editing both balanced legs or deleting an entire group appears able to satisfy that check. The migration's final comment incorrectly claims no separate reject trigger is needed. This will be tested using synthetic ledger groups after database isolation.

The source also contains batch row locking and a unique (merchant,date) key; absence of the claimed singleton lock alone does not prove duplicate CloseBatch financial effects (FINDING-023).

**Dependency preparation:** `npm ci --offline --ignore-scripts --no-audit --no-fund` in the temporary source copy installed 179 packages from the existing npm cache. [dependency-install.txt](runtime-artifacts/dependency-install.txt). The PostgreSQL 16.9 Windows binary package was installed separately with lifecycle scripts disabled: [postgres-package-install.txt](runtime-artifacts/postgres-package-install.txt). Binary provenance: [upstream project](https://github.com/leinelissen/embedded-postgres). No source changes or production data were used.

### EVID-004 — Windows pg_ctl fails; direct server launch attempted

**Timestamp:** 2026-10-30 10:55:22 +03:00.

**Status:** Failed environment attempt; no application or migration ran. The portable `initdb` command returned exit 0 and created the new cluster, but included restricted-token diagnostics. `pg_ctl -D <new-temp-pgdata> -l <temp-log> -w start` failed with `could not create restricted token: error code 87` / `could not start server: error code 3`. [postgres-initdb.txt](runtime-artifacts/postgres-initdb.txt), [postgres-start.txt](runtime-artifacts/postgres-start.txt).

This is an investigation-host launcher limitation, not a FilsPay defect. The next safe method starts `postgres.exe` directly with explicit `-h 127.0.0.1` and a fresh local port; no administrative elevation or permission expansion is requested.

### EVID-005 — Direct PostgreSQL server verified; database isolation established

**Timestamp:** 2026-10-30 10:56:34 +03:00.

**Status:** Verified. The direct process is PostgreSQL 16.9, bound solely to 127.0.0.1:62998. Server data directory matches the new temporary cluster after normalizing Windows path case. Initial verification halted before mutations; its inet/text comparison was too strict, so this harness uses `host(inet_server_addr())`. This correction affects only investigation code.

[isolation.json](runtime-artifacts/isolation.json) records server version/address/port, actual data directory, listener setting, start time and initial database inventory (only postgres and templates). New empty `fils_forensic_clean` is created only after those checks. Child environments are whitelisted, with explicit local DATABASE_URL and no PGCONN_SETTLEMENT, PGHOST, dotenv or real credentials. No production or shared target is used.

**Command:** `node Evidence/runtime-artifacts/verify-db.mjs`.

### EVID-006 — Clean migration failure and independent migration probes

**Timestamp:** 2026-10-30 10:56:38 +03:00.

**Status:** REPRODUCED. **Command:** `node --import tsx db/migrate.ts` in the temporary unmodified checkout, explicit local DATABASE_URL. [clean-migrate.txt](runtime-artifacts/clean-migrate.txt). 51 migrations applied before the runner stopped. Separate 0054/0055 probes ran and rolled back individually:

```json
[
  {
    "name": "0054_views.sql",
    "code": "42P01",
    "message": "relation \"settlement_batch_events\" does not exist",
    "position": "679"
  },
  {
    "name": "0055_chart_of_accounts_suspense.sql",
    "code": "42703",
    "message": "column \"code\" of relation \"chart_of_accounts\" does not exist",
    "position": "100"
  }
]
```

[migration-probes.json](runtime-artifacts/migration-probes.json). No migration/source edits. Full normal startup is blocked by the supplied migration chain; any later partial schema will disclose omissions.

### EVID-007 — Explicit partial-schema fixture permits independent subsystem testing

**Timestamp:** 2026-10-30 10:57:56 +03:00.

**Status:** Temporary test setup, NOT successful full migration or deployment. A second new database `fils_forensic_partial` was created inside the verified loopback cluster. Each original SQL migration ran byte-for-byte in its own transaction; failed migrations were rolled back and omitted, then testing continued to independent later migrations.

**Omissions:**

```json
[
  {
    "name": "0054_views.sql",
    "status": "failed/omitted",
    "code": "42P01",
    "message": "relation \"settlement_batch_events\" does not exist"
  },
  {
    "name": "0055_chart_of_accounts_suspense.sql",
    "status": "failed/omitted",
    "code": "42703",
    "message": "column \"code\" of relation \"chart_of_accounts\" does not exist"
  }
]
```

Applied 64/66 migrations. [partial-schema.json](runtime-artifacts/partial-schema.json). No migration source was modified, no missing table was fabricated, and no real data was imported. All tests below explicitly use this partial-schema fixture unless stated otherwise. This cannot demonstrate full-system readiness.

**Command:** `node Evidence/runtime-artifacts/partial-db.mjs`.

### EVID-008 — Unmodified TypeScript typecheck

**Timestamp:** 2026-10-30 10:59:21 +03:00.

**Status:** Failed. **Command:** `npm run typecheck` in the temporary source copy. [typecheck.txt](runtime-artifacts/typecheck.txt). No emit, source edits or fixers. Exact diagnostics retained; failure is not treated as proof of exploitability.

### EVID-009 — Original Go suite on isolated partial schema

**Timestamp:** 2026-10-30 10:59:53 +03:00.

**Status:** Failed or incomplete. **Command:** `go test -count=1 -json ./...`, isolated local DATABASE_URL, separate temporary module/build caches. [go-original-tests.txt](runtime-artifacts/go-original-tests.txt). No existing tests changed. Per-test skips/failures must be counted from the artifact; a package-level pass alone does not prove all tests ran. The DB fixture omits failed migrations listed in partial-schema.json.

### EVID-010 — Additional authorization and isolation leads identified

**Timestamp:** 2026-10-30 11:04:04 +03:00.

**Status:** Static review before reproduction. Beyond the original 32, review found: lookupSession uses live_sessions without authenticated=true; live_sessions (0058) includes pending sessions; login's global-email OTP recipient can differ from the password-verified user; report scoping checks whether a requested merchant is ANY split child rather than the caller's child; admin API-key rotation appears not to revoke the old key. These are leads, not yet runtime claims. Core probes use a separate new database with the same disclosed omitted migrations: `[{"name":"0054_views.sql","code":"42P01","message":"relation \"settlement_batch_events\" does not exist"},{"name":"0055_chart_of_accounts_suspense.sql","code":"42703","message":"column \"code\" of relation \"chart_of_accounts\" does not exist"}]`.

### EVID-011 — P001 — Empty expired-hold selection deletes unexpired holds

**Timestamp:** 2026-10-30 11:04:09 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-001. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "input": {
    "activeUnexpiredHolds": 1,
    "expiredHolds": 0
  },
  "expected": "No deletions",
  "actual": {
    "sql": "DELETE FROM holds",
    "values": [],
    "deleted": 1
  },
  "repetitions": 1
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P001`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-012 — P002 — Balanced ledger history can be edited and deleted

**Timestamp:** 2026-10-30 11:04:09 +03:00.

**Status:** REPRODUCED. **Related:** New discovery. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "Historical ledger immutable; unbalanced groups rejected",
  "actual": {
    "balancedLegsUpdated": 2,
    "balancedLegsDeleted": 2,
    "unbalancedInsertRejected": "ledger_entries group 7076853c-811c-47f2-8fec-365b46ba04d0 does not balance: net 1 fils"
  },
  "conditions": "Ordinary SQL under application-owner-equivalent local role; no superuser trigger bypass",
  "newId": "NEW-001"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P002`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-013 — P003 — Pending merchant session grants API access before OTP

**Timestamp:** 2026-10-30 11:04:09 +03:00.

**Status:** REPRODUCED. **Related:** New discovery. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "401 until OTP verified",
  "actual": {
    "authenticatedColumn": false,
    "authMeHttp": 200,
    "apiKeysHttp": 200
  },
  "newId": "NEW-002",
  "limits": "Does not require predicting an OTP or acquiring another user token; pending token is legitimately issued after password."
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P003`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-014 — P004 — CSV precision error and duplicate import both commit

**Timestamp:** 2026-10-30 11:04:09 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-012. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "input": {
    "amountBhd": "4.750",
    "uploads": 2,
    "sameFilenameAndRows": true
  },
  "expectedPerImportFils": 4750,
  "actual": {
    "twoDecimal": 475,
    "threeDecimal": 475,
    "totalPayableCredits": "950",
    "distinctImportIds": true
  },
  "repetitions": 2
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P004`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-015 — P005 — Second approver comparison accepts same ID renamed

**Timestamp:** 2026-10-30 11:04:09 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-015. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "Compare stable admin IDs",
  "actual": {
    "sameIdDifferentNamesAccepted": true,
    "differentIdsSameNameRejected": "self_approval_forbidden"
  },
  "limits": "Direct guard reproduction; ability to rename an admin through a deployed UI is not asserted."
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P005`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-016 — P006 — Refund chain accepts cross-merchant target

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** FAILED ATTEMPT. **Related:** FINDING-013. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "name": "error",
  "message": "new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"",
  "code": "23514",
  "stack": "error: new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"\n    at C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\node_modules\\pg\\lib\\client.js:694:17\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at async <anonymous> (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\payments\\processRefund.ts:177:26)\n    at async withTransaction (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\db\\withTransaction.ts:30:22)\n    at async probe.notes (file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:29:227)\n    at async probe (C:\\Users\\hanwd\\OneDrive\\Desktop\\fils-pay\\Evidence\\runtime-artifacts\\probe-lib.mjs:44:13)\n    at async file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:28:1"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P006`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-017 — P007 — Partial capture can refund more than captured

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** FAILED ATTEMPT. **Related:** New discovery. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "name": "error",
  "message": "new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"",
  "code": "23514",
  "stack": "error: new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"\n    at C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\node_modules\\pg\\lib\\client.js:694:17\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at async <anonymous> (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\payments\\processRefund.ts:177:26)\n    at async withTransaction (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\db\\withTransaction.ts:30:22)\n    at async file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:33:178\n    at async probe (C:\\Users\\hanwd\\OneDrive\\Desktop\\fils-pay\\Evidence\\runtime-artifacts\\probe-lib.mjs:44:13)\n    at async file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:32:1"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P007`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-018 — P008 — Concurrent refund helpers over-refund and lose running total

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** FAILED ATTEMPT. **Related:** New discovery. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "name": "error",
  "message": "new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"",
  "code": "23514",
  "stack": "error: new row for relation \"refunds\" violates check constraint \"chk_refunds_reason_not_null\"\n    at C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\node_modules\\pg\\lib\\client.js:694:17\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at async <anonymous> (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\payments\\processRefund.ts:177:26)\n    at async withTransaction (C:\\Users\\hanwd\\AppData\\Local\\Temp\\filspay-forensic-euGZtR\\checkout\\apps\\api\\src\\db\\withTransaction.ts:30:22)\n    at async Promise.all (index 0)\n    at async file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:36:440\n    at async probe (C:\\Users\\hanwd\\OneDrive\\Desktop\\fils-pay\\Evidence\\runtime-artifacts\\probe-lib.mjs:44:13)\n    at async file:///C:/Users/hanwd/OneDrive/Desktop/fils-pay/Evidence/runtime-artifacts/probes1.mjs:35:1"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P008`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-019 — P009 — Partial refund rounding reverses more fee than originally charged

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** New discovery. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "related": "FINDING-013",
  "input": {
    "capturedFils": 1000,
    "feeChargedFils": 25,
    "refunds": [
      300,
      300,
      300,
      100
    ]
  },
  "actual": {
    "reversals": [
      8,
      8,
      8,
      2
    ],
    "totalReversed": 26
  },
  "expectedMaximumReversal": 25
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P009`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-020 — P010 — Payment link reservation can be reclaimed during capture

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-007. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "Single successful capture per link",
  "actual": {
    "responses": [
      200,
      200
    ],
    "captured": {
      "n": 2,
      "total": "2000"
    }
  },
  "conditions": "Acquirer barrier; reservation timestamp advanced to represent >60s elapsed without a wall-clock wait. Actual pay/authorize/capture/finalize functions and SQL executed.",
  "repetitions": 1
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P010`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-021 — P011 — Unsigned callbacks and duplicate callback IDs append twice

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-008. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "input": {
    "unsigned": true,
    "repeatedCallbackId": true,
    "oldOccurredAt": true
  },
  "expected": "Authentication, freshness and dedupe",
  "actual": {
    "responses": [
      200,
      200
    ],
    "notes": 2,
    "signatureFromUnixSecond1StillValid": true
  },
  "negativeControl": "callbacks only append notes; they do not capture funds"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P011`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-022 — P012 — Replay mints another event identity and another payout record

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-010. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "input": {
    "oneBatchNetFils": 975,
    "endpoints": 2,
    "replays": 1
  },
  "expected": "One payout record independent of webhook count",
  "actual": {
    "initialRecords": 2,
    "afterReplay": {
      "n": 3,
      "total": "2925"
    },
    "transportCalls": 3,
    "bodyAndHeaderEventIdsChanged": true
  },
  "limits": "Injected transport sends no HTTP; records are local operational rows, not bank transfers."
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P012`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-023 — P013 — Cache correction changes no ledger entries

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-006. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "Journaled correction if ledger is source of truth",
  "actual": {
    "cacheBefore": 1000,
    "cacheAfter": 1500,
    "ledgerEntries": 0
  },
  "qualification": "Cache-only intent exists in ADR-0006; defect is incompatible writers/docs and loss on rebuild, not an unbalanced ledger group."
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P013`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-024 — P014 — Status recompute clears sandbox even with an open authorization

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-021. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "Status tidy-up preserves sandbox flag",
  "actual": {
    "summary": {
      "merchantId": "491b297e-bbd3-41b4-806d-843294deb5d7",
      "scanned": 1,
      "updated": 0,
      "openAuthorizations": 0
    },
    "flags": [
      "test_mode"
    ],
    "testModeAfter": false,
    "realOpenAuthorizations": 1
  },
  "additional": "Candidate SQL excludes authorized rows, so its openAuthorizations counter is always zero."
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P014`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-025 — P015 — Admin impersonation carries merchant write authority after disable

**Timestamp:** 2026-10-30 11:04:10 +03:00.

**Status:** REPRODUCED. **Related:** FINDING-014. **Method:** actual unmodified source functions / local PostgreSQL / Fastify inject; any controlled dependency is described below. **Reproduction command:** `node Evidence/runtime-artifacts/run-probes.mjs probes1.mjs`.

**Inputs, expectations, sanitized observations and limits:**

```json
{
  "expected": "View-only support grant; disabled admin loses authority",
  "actual": {
    "merchantRole": "owner",
    "writeBeforeDisable": 201,
    "writeAfterDisable": 201
  },
  "tokens": "redacted/never output"
}
```

Machine-readable result: [probe-results.ndjson](runtime-artifacts/probe-results.ndjson), record `P015`. Source excerpts, severity, remediation and cross-references are consolidated in the finding catalog. No real processor or external merchant request was made.

### EVID-026 — Unmodified TypeScript typecheck

**Timestamp:** 2026-10-30 11:07:06 +03:00.

**Status:** Passed. **Command:** `npm run typecheck` in the temporary source copy. [typecheck.txt](runtime-artifacts/typecheck.txt). No emit, source edits or fixers. Exact diagnostics retained; failure is not treated as proof of exploitability.

### EVID-027 — Original TypeScript suite on isolated partial schema

**Timestamp:** 2026-10-30 11:07:55 +03:00.

**Status:** Failed or incomplete. **Command:** `npm test` in temporary checkout with explicit local DATABASE_URL, synthetic webhook key, and KYC output redirected outside the repository. [ts-original-tests.txt](runtime-artifacts/ts-original-tests.txt). Existing tests are unmodified. Partial schema limitations are recorded separately; failures are retained without repair.

## 6. Previously Reported Findings — Verification Matrix

| Original ID | Issue | Severity | Verification Status | Evidence ID | Notes |
|---|---|---|---|---|---|
| FINDING-001 | `expire_holds.ts` deletes all holds when nothing has expired | Critical | REPRODUCED | EVID-011 | Empty expired-hold selection deletes unexpired holds; local synthetic reproduction (P001). |
| FINDING-002 | Net payout computed in float32 | Critical | NOT TESTED | — | Independent verification pending. |
| FINDING-003 | Scheme file amounts are rounded, ledger amounts truncated | High | NOT TESTED | — | Independent verification pending. |
| FINDING-004 | ADR-0002 residue posting does not exist | High | NOT TESTED | — | Independent verification pending. |
| FINDING-005 | Console "Rebuild cached balances" uses lifetime gross scheme lines | Critical | NOT TESTED | — | Independent verification pending. |
| FINDING-006 | Balance cache has three inconsistent writers; Adjust is cache-only | High | REPRODUCED | EVID-023 | Cache correction changes no ledger entries; local synthetic reproduction (P013). |
| FINDING-007 | Payment link double payment via reservation timeout | Critical | REPRODUCED | EVID-020 | Payment link reservation can be reclaimed during capture; local synthetic reproduction (P010). |
| FINDING-008 | Acquirer callback authentication is optional and non-replay-safe | High | REPRODUCED | EVID-021 | Unsigned callbacks and duplicate callback IDs append twice; local synthetic reproduction (P011). |
| FINDING-009 | `reconcile_march.ts` is non-idempotent and mis-posts | High | NOT TESTED | — | Independent verification pending. |
| FINDING-010 | Payout disbursement recorded by webhook delivery | High | REPRODUCED | EVID-022 | Replay mints another event identity and another payout record; local synthetic reproduction (P012). |
| FINDING-011 | Platform volume counter overflow (INTEGER / int32) | High | NOT TESTED | — | Independent verification pending. |
| FINDING-012 | Admin CSV import posts amounts 10× too small; no duplicate guard | Critical | REPRODUCED | EVID-014 | CSV precision error and duplicate import both commit; local synthetic reproduction (P004). |
| FINDING-013 | Refund helper defects (FP-212) | Critical (if wired) | NOT TESTED | — | Independent verification pending. |
| FINDING-014 | Impersonation grants write-capable merchant roles to any admin | High | REPRODUCED | EVID-025 | Admin impersonation carries merchant write authority after disable; local synthetic reproduction (P015). |
| FINDING-015 | Second-approver check compares display names | High | REPRODUCED | EVID-015 | Second approver comparison accepts same ID renamed; local synthetic reproduction (P005). |
| FINDING-016 | Predictable OTPs and payment-link tokens (`Math.random`) | High | NOT TESTED | — | Independent verification pending. |
| FINDING-017 | Session fixation on OTP promotion | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-018 | Webhook signatures over canonical JSON, body sent raw | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-019 | Webhook replay semantics break receiver dedupe and admin controls | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-020 | Recalculate MDR rewrites paid batches and double-counts | High | NOT TESTED | — | Independent verification pending. |
| FINDING-021 | "Recompute transaction statuses" clears `test_mode` | High | REPRODUCED | EVID-024 | Status recompute clears sandbox even with an open authorization; local synthetic reproduction (P014). |
| FINDING-022 | Seed truncates the whole business database | Critical | NOT TESTED | — | Independent verification pending. |
| FINDING-023 | Settlement singleton lock (FP-208) absent; daemon/CLI overlap possible | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-024 | Daemon business date derived from UTC date | Low-Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-025 | TS and Go fee formulas diverge | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-026 | Split shares may not sum to net payout | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-027 | Migrations 0054/0055 likely fail on a fresh database; numbers reused | Medium | REPRODUCED | EVID-006 | Fresh PostgreSQL 16 chain fails; 0054/0055 independently probed. |
| FINDING-028 | Committed secret and production flag in compose env | High | NOT TESTED | — | Independent verification pending. |
| FINDING-029 | Database exposure and shared role | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-030 | Reporting double-apply and outbox ordering | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-031 | Credits post backdated ledger legs; fee reversal at current rate | Medium | NOT TESTED | — | Independent verification pending. |
| FINDING-032 | Admin role enforcement vs production audit evidence | Medium | NOT TESTED | — | Independent verification pending. |

## 7. Confirmed Runtime Defects

None claimed at opening.

## 8. Security Findings

Pending independent verification.

## 9. Financial Integrity Findings

Pending independent verification.

## 10. Database and Migration Findings

Pending independent verification.

## 11. API and Workflow Findings

Pending independent verification.

## 12. New Discoveries

None claimed at opening.

## 13. Git and Forensic Connections

Pending evidence and history cross-checks. Unusual history alone does not establish intent.

## 14. Failed Reproduction Attempts

None at opening.

## 15. Unverified Findings and Blockers

Docker and PostgreSQL CLI are absent from PATH; availability of alternative disposable runtime remains to be investigated.

## 16. Risk and Severity Assessment

Pending verification. Impact and confidence will be rated separately.

## 17. Recommended Remediation Priorities

Recommendations only; no fixes authorized.

## 18. Final Conclusions

Investigation in progress.

## Appendix A — Sanitized Commands and Outputs

Detailed supporting artifacts, when needed, will be saved under `runtime-artifacts/` and linked here. No secrets or full environment dumps will be retained.

## Appendix B — Source File References

Initial evidence inventory (all existed before investigation):

| Path | Bytes | Purpose |
|---|---:|---|
| `Evidence/DOCS_FULL_INVESTIGATION.md` | 87820 | Prior documentation investigation (pre-existing untracked file) |
| `Evidence/FilsPay_Git_Commit_and_Code_Comments_Evidence.md` | 127774 | Prior Git/comment investigation |
| `Evidence/FilsPay_The_Order_of_the_Prompt_Story.md` | 8436 | Prior forensic narrative |
| `Evidence/messages.md` | 2719 | Encoded/decoded messages |
| `Evidence/allcommits` | 60336 | Prior commit inventory |
| `Evidence/old-agints-instration/.cursorrules` | 3103 | Archived untrusted instructions |
| `Evidence/old-agints-instration/AGENTS.md` | 3478 | Archived untrusted instructions |
| `Evidence/old-agints-instration/CLAUDE.md` | 3197 | Archived untrusted instructions |

## Appendix C — Test Coverage and Limitations

All runtime tests remain pending. Existing tests will be inspected before execution for database/network or mutation side effects. Passing repository tests alone will not establish financial or security correctness.
