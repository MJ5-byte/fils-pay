# FilsPay: static tooling and safe verification record

Date/baseline: 2026-10-30, `7aeb2831d1cfc00a741c33a31ca94c7939e1b43c`.

## Installed skills versus executable availability

All seven requested skill documents were readable in the session:

- audit-context-building 2.0.2
- spec-to-code-compliance 2.0.2
- differential-review 1.1.4
- static-analysis:semgrep, :codeql, :sarif-parsing 1.5.1
- fp-check 1.0.5

They reside under `C:\Users\hanwd\.codex\plugins\cache\trailofbits`. A skill's presence is **not** evidence a scanner executable or its licensed engine exists.

| Check | Observed result | Disposition |
|---|---|---|
| `Get-Command semgrep`, `where.exe semgrep` | No executable resolved; where reported no matching files | Semgrep unavailable on session PATH |
| Python installation `Python313\Scripts` lookup | No Semgrep entry found | Corroborates scoped lookup |
| Explicit Python 3.13 `-B -m pip show semgrep` | `WARNING: Package(s) not found: semgrep` | Not installed in that interpreter |
| `Get-Command codeql`, `where.exe codeql` | No executable resolved | CodeQL unavailable on session PATH |
| Selected conventional tool directories | No CodeQL executable found in inspected locations | Not an exhaustive disk-wide inventory |
| Repository recursive `*.sarif` search | No files returned | No SARIF input to parse/deduplicate |
| Root/API `node_modules` | Both absent | Full npm application tests unavailable without dependency preparation |
| `node --version` | `v22.19.0` | Used for isolated probes |

The initial Windows `python.exe` alias failed with “file cannot be accessed”; invoking the explicit installed Python executable succeeded for package inspection. This was an interpreter-selection issue, not a scanner result.

## Semgrep workflow disposition

Applied skill prerequisite/language detection. Languages include TypeScript/JavaScript, Go and SQL. No Semgrep CLI means no OSS/Pro availability result, no ruleset approval request, no scanner execution, and no finding count. No tool was installed.

The skill requires explicit ruleset-plan approval before scanning; that gate was not reached. Its usual JSON/SARIF/repository-clone outputs would also conflict with the user's Markdown-only write rule unless a separately approved artifact policy were established. No `semgrep` command was executed and no telemetry was sent.

## CodeQL workflow disposition

Stopped at unavailable CLI. No database was built or reused, no query packs downloaded, no suite generated, no extraction-quality checks run, no data extension models created, and no queries executed. There is **no CodeQL security verdict**.

Potential future scope, not an executed plan: JavaScript/TypeScript and Go; explicit suites, extraction verification and modeling of custom auth/database/webhook wrappers would be necessary. This report is not a recommendation to install automatically.

## SARIF parsing disposition

Applied input discovery and reviewed the SARIF skill. With no SARIF files or scanner runs, schema validation, severity inheritance, fingerprint normalization, deduplication and aggregation are **not applicable**, rather than zero-result successes. No fabricated SARIF artifact was created.

If results are later supplied, resolve severity from result override or rule defaults and normalize whole paths; do not interpret absent `result.level` as a clean CodeQL result.

## Manual analysis actually performed

Read source/migrations and relevant tests; searched auth predicates, tenant keys, SQL construction, revocation/trigger definitions, ledger writes, replay/idempotency paths, outbox consumers, configuration and risky historical deltas. `rg`/Git searches are manual triage, **not Semgrep, CodeQL, taint-analysis or dependency-vulnerability scans**.

No package advisory/SCA query, internet research or third-party code execution was performed. Dependency versions in lockfiles have not been certified safe.

## In-memory source probes

Executed three PowerShell here-string → `node --input-type=module` commands. They read TypeScript source, used Node's experimental `stripTypeScriptTypes`, removed module imports/exports in memory, and supplied only explicitly selected local dependencies or synthetic stubs. They wrote no files and opened no network/database connections.

This is a **function/source probe**, not the packaged application or framework. Stubs cannot validate PostgreSQL locking, route registration, constraints or production deployment. Full call-chain/schema inspection separately supports the source conclusions.

| Probe | Observed assertion/output | What it does not prove |
|---|---|---|
| P1 | Actual inbound verifier accepted unsigned optional-mode callback; rejected unsigned strict-mode callback; accepted a correctly signed timestamp `1` | No live callback insertion or production flag value |
| P2 | Actual production URL validator accepted HTTPS IPv4 loopback, IPv6 loopback and RFC1918 address; rejected HTTP | No live internal target/TLS reachability or response extraction |
| P3 | Actual role gate denied support impersonation on an owner-gated route; actual writer helper mapped impersonation to merchant_session; API key passed role gate | No claim API-key full authority is itself a bug |
| P4 | Actual session lookup query and committed view both omit authenticated=true | No database-backed login reproduction |
| P5 | Actual approver helper accepted same admin ID with changed display name; rejected different IDs with same name | No reachable staff-name-change capability |
| P6 | Actual payment-link expiry reference accepted year-2000 submittedAt | Architecture explicitly permits client-clock policy |
| P7 | Actual import parser: `4.75` → 475; actual currency parser: `4.75` → 4750 | No finance import transaction executed |
| P8 | Actual refund-fee helper: captured 300, fee 2, refunds 100+100+100 → reversals 1+1+1 | Public refund route is still dormant |
| P9 | Explicit float32-operation **model**, gross 20,000,123 minus fee 550,003: expected 19,450,120; modeled 19,450,119 | Model used `Math.fround`; Go binary was not executed |
| P10 | Actual payout effect issued two INSERT calls for same batch/positive amount; zero amount skipped. Migration has no UNIQUE batch constraint | Mock calls do not establish real bank transmission |
| P11 | Actual outbound signer did not match HMAC over ordinary JSON.stringify bytes for `{z:1,a:2}` | Canonicalizing receiver remains compatible |
| P12 | Actual rotation helper locked/read old key and called issuance/audit without a revocation query; issuance separately inspected | Helper dependencies were synthetic; not an integrated rotation test |

All assertions completed successfully. Node emitted an experimental API warning. These are **12 labeled checks, not 12 full integration tests**; P9 is explicitly a model.

### Representative reproducible probe harness

The harness below shows the exact transformation used; it intentionally avoids importing application entrypoints:

```javascript
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
function load(path, names, deps = {}) {
  const raw = fs.readFileSync(path, "utf8");
  const js = stripTypeScriptTypes(raw, { mode: "strip" })
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/\bexport\s+/g, "");
  return Function(...Object.keys(deps),
    js + "\nreturn {" + names.join(",") + "};")(...Object.values(deps));
}
```

It is appropriate only for the inspected modules and controlled dependencies, not as a general-purpose safe loader for arbitrary untrusted source. Source execution was limited to selected functions; no repository scripts were run.

## Safety and workspace state

At opening, 18 staged prior Evidence additions already existed. Later read-only status checks also showed external changes to root `AGENTS.md` and an untracked `Evidence/bug-merge-backup/` directory. These were not created or altered by this investigation and were not undone.

Before report creation, `git diff --quiet HEAD -- apps packages db scripts ops` returned exit 0. Final preservation check is recorded in `FINAL_REPORT.md`. No attempt was made to reset unrelated work or claim the whole workspace was clean.
