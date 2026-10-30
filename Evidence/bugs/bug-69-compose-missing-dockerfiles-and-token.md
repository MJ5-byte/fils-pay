# Bug 69 — Compose cannot build, and the settlement daemon exits without its token

**Severity:** High · **Area:** Ops · **Source:** CODE-016, CODE-026, CODE-037

## Where
- `ops/docker-compose.yml:42,61,72,94,113` — `dockerfile: ops/Dockerfile.node` and `ops/Dockerfile.go`
- Neither file is in the tree or in git history
- `ops/docker-compose.yml:95` — comment says the daemon falls back to `SETTLEMENT_INTERNAL_TOKEN=dev-token`
- `apps/settlement/internal/config/config.go:112-120` — `RequireInternalToken` returns an error when the variable is empty. There is no `dev-token` default.
- The API's own token is `""` outside production (`apps/api/src/config.ts`), and the Go server rejects an empty bearer
- Bug 50: the committed dev webhook key decodes to 34 bytes, so the API also refuses to boot until `WEBHOOK_SECRET_ENCRYPTION_KEY` is a real 32-byte key

## What's wrong
`docker compose build` fails on the missing Dockerfiles. If the images are supplied some other way, `daemon` still exits at startup because the token is unset, and the API still exits because the built-in encryption key is the wrong length. The comments describe a stack that boots. This one does not.

## Why
The Dockerfiles and the fallback token were described and never added. The dev key string is 34 bytes after base64 decode (`test-key-for-dev-only-not-for-prod`).

## What it breaks
A fresh checkout cannot run the stack the ops README describes. Admin batch, rebuild, and MDR calls have nothing to talk to (`ECONNREFUSED` on `:8091` in the audit export).

## Smallest fix
Add the two Dockerfiles, set `SETTLEMENT_INTERNAL_TOKEN` on both the API and the daemon from a secret, and replace the 34-byte fallback with 32 bytes or delete the fallback.
