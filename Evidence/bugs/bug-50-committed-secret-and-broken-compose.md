# Bug 50 — Acquirer secret committed; compose does not load `.env.docker`

**Severity:** High · **Area:** Ops / secrets · **Clue:** Security audit — run `docker compose up` in `ops/`; Architecture `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default false

## Where
- `ops/.env.docker` — acquirer secret in git (`.gitignore` only covers `.env` / `.env.local`)
- `ops/docker-compose.yml` — API service has no `env_file: .env.docker` (comment claims auto-load)
- `apps/api/src/config.ts` — dev fallback webhook encryption key is 34 bytes, not 32, so boot can fail without `WEBHOOK_SECRET_ENCRYPTION_KEY`

## What's wrong
A sandbox secret is in the repo. Compose does not actually inject the file the README points at. Local/cloud boots either run with unsigned-callback defaults or fail on the encryption key length.

## Why
Copy-paste compose + a dummy key that was never 32 bytes.

## What it breaks
Leaked secret. Dilmune / local bring-up does not match docs. Callbacks stay unsigned (Bug 38).

## Smallest fix
Remove the secret from git, gitignore `.env.docker`, add `env_file`, fix the fallback key to 32 bytes (or require the env var).
