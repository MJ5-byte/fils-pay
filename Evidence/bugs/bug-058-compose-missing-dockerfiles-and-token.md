# BUG-058 — Docker Compose References Missing Dockerfiles and Settlement Daemon Exits

## 1. Summary

`docker compose build` fails on the missing Dockerfiles.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Infrastructure and configuration
- Affected Component: ops/docker-compose.yml, apps/settlement/internal/config/config.go
- Reachability: Reachable on docker compose build / up
- Original Contributors / Sources: CODE-016, CODE-026, CODE-037

## 3. Root Cause

The Dockerfiles and the fallback token were described and never added. The dev key string is 34 bytes after base64 decode (`test-key-for-dev-only-not-for-prod`).

## 4. Affected Files and Functions

- `ops/docker-compose.yml:42,61,72,94,113` — `dockerfile: ops/Dockerfile.node` and `ops/Dockerfile.go`
- Neither file is in the tree or in git history
- `ops/docker-compose.yml:95` — comment says the daemon falls back to `SETTLEMENT_INTERNAL_TOKEN=dev-token`
- `apps/settlement/internal/config/config.go:112-120` — `RequireInternalToken` returns an error when the variable is empty. There is no `dev-token` default.
- The API's own token is `""` outside production (`apps/api/src/config.ts`), and the Go server rejects an empty bearer
- Bug 50: the committed dev webhook key decodes to 34 bytes, so the API also refuses to boot until `WEBHOOK_SECRET_ENCRYPTION_KEY` is a real 32-byte key

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`docker compose build` fails on the missing Dockerfiles. If the images are supplied some other way, `daemon` still exits at startup because the token is unset, and the API still exits because the built-in encryption key is the wrong length. The comments describe a stack that boots. This one does not.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `ops/docker-compose.yml:42,61,72,94,113` — `dockerfile: ops/Dockerfile.node` and `ops/Dockerfile.go`
- Neither file is in the tree or in git history
- `ops/docker-compose.yml:95` — comment says the daemon falls back to `SETTLEMENT_INTERNAL_TOKEN=dev-token`
- `apps/settlement/internal/config/config.go:112-120` — `RequireInternalToken` returns an error when the variable is empty. There is no `dev-token` default.
- The API's own token is `""` outside production (`apps/api/src/config.ts`), and the Go server rejects an empty bearer
- Bug 50: the committed dev webhook key decodes to 34 bytes, so the API also refuses to boot until `WEBHOOK_SECRET_ENCRYPTION_KEY` is a real 32-byte key

Technical details:
`docker compose build` fails on the missing Dockerfiles. If the images are supplied some other way, `daemon` still exits at startup because the token is unset, and the API still exits because the built-in encryption key is the wrong length. The comments describe a stack that boots. This one does not.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A fresh checkout cannot run the stack the ops README describes. Admin batch, rebuild, and MDR calls have nothing to talk to (`ECONNREFUSED` on `:8091` in the audit export).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: CODE-016, CODE-026, CODE-037. Legacy file: `bug-69-compose-missing-dockerfiles-and-token.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Add the two Dockerfiles, set `SETTLEMENT_INTERNAL_TOKEN` on both the API and the daemon from a secret, and replace the 34-byte fallback with 32 bytes or delete the fallback.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-69-compose-missing-dockerfiles-and-token.md`

## 17. Evidence References

`ops/docker-compose.yml, apps/settlement/internal/config/config.go`, `bug-69-compose-missing-dockerfiles-and-token.md`
