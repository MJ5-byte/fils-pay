# BUG-057 — Acquirer Secret Committed in Git and Fallback Webhook Key Length Invalid

## 1. Summary

A sandbox secret is in the repo.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Infrastructure and configuration
- Affected Component: ops/.env.docker, ops/docker-compose.yml, apps/api/src/config.ts
- Reachability: Present in git repository and default docker compose environment
- Original Contributors / Sources: Security audit, code audit

## 3. Root Cause

Copy-paste compose + a dummy key that was never 32 bytes.

## 4. Affected Files and Functions

- `ops/.env.docker` — acquirer secret in git (`.gitignore` only covers `.env` / `.env.local`)
- `ops/docker-compose.yml` — API service has no `env_file: .env.docker` (comment claims auto-load)
- `apps/api/src/config.ts` — dev fallback webhook encryption key is 34 bytes, not 32, so boot can fail without `WEBHOOK_SECRET_ENCRYPTION_KEY`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A sandbox secret is in the repo. Compose does not actually inject the file the README points at. Local/cloud boots either run with unsigned-callback defaults or fail on the encryption key length.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `ops/.env.docker` — acquirer secret in git (`.gitignore` only covers `.env` / `.env.local`)
- `ops/docker-compose.yml` — API service has no `env_file: .env.docker` (comment claims auto-load)
- `apps/api/src/config.ts` — dev fallback webhook encryption key is 34 bytes, not 32, so boot can fail without `WEBHOOK_SECRET_ENCRYPTION_KEY`

Technical details:
A sandbox secret is in the repo. Compose does not actually inject the file the README points at. Local/cloud boots either run with unsigned-callback defaults or fail on the encryption key length.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Leaked secret. Dilmune / local bring-up does not match docs. Callbacks stay unsigned (Bug 38).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Security audit, code audit. Legacy file: `bug-50-committed-secret-and-broken-compose.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Remove the secret from git, gitignore `.env.docker`, add `env_file`, fix the fallback key to 32 bytes (or require the env var).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-50-committed-secret-and-broken-compose.md`

## 17. Evidence References

`ops/.env.docker, ops/docker-compose.yml, apps/api/src/config.ts`, `bug-50-committed-secret-and-broken-compose.md`
