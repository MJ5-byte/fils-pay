# Containers do not run

**Status:** Resolved (2026-10-29/30)

## Symptom
`ops/README.md`'s Quick-start commands fail: `docker compose build` cannot
produce any image, so no container in the stack ever starts.

## Root cause
- `ops/docker-compose.yml` referenced `ops/Dockerfile.node` and
  `ops/Dockerfile.go`, which **never existed in any commit** (B24) — the build
  failed immediately.
- Two further silent boot killers once the Dockerfiles existed: the settlement
  daemon requires `SETTLEMENT_INTERNAL_TOKEN` at boot (no built-in default
  exists despite the docs), and `ops/.env.docker` was never loaded (compose
  auto-loads only `.env`, never a file by this name).

## Fix
- Added `ops/Dockerfile.node` (node:20-slim; python3+make+g++ for the argon2
  native addon, and `npm ci`) and `ops/Dockerfile.go` (multi-stage Go build;
  `cmd/settlement/main.go` imports `time/tzdata` so the final stage needs no
  tzdata).
- Wired `SETTLEMENT_INTERNAL_TOKEN=dev-token` into api + settlement and
  `env_file: .env.docker` on every service; added the webhook encryption key
  and acquire-signature flag to `.env.docker`.

## Verification
- `docker compose build` succeeds (all five images).
- Full boot: postgres → migrate **71/71** → seed (all REAL assertions pass) →
  api + settlement + reporting up; settlement daemon ran a real daily batch
  (7 merchants) and scheduled the next check-in; a live refund through the
  composed API returned 200 with a balanced ledger group.

## Evidence
Commits `fbddb5c` (Dockerfiles + compose wiring) and `f2df131` (the two build
fixes the first real build exposed: argon2 toolchain, Go module root).

## Residual operational notes
- **First-run race (podman-compose):** the very first `run --rm migrate` can
  race postgres readiness and error; the second run applies cleanly. The
  README now waits for `pg_isready` first.
- **Unmigrated stack trap:** starting `up api settlement reporting` against a
  fresh volume boots every service but each DB call fails with
  "relation … does not exist" and the daemon retries noisily every minute.
  Run migrate + seed before the services (the README order matters).
- **Recurring rootless-crun failure** (`crun start … cannot open
  /run/user/1000/crun/…/exec.fifo`): rootless podman keeps per-container FIFO
  state under `/run/user/1000`, which is recreated whenever the login session
  restarts — any container whose state lived in the old dir then fails to
  start with this exact error. It is environmental, not a compose bug: the
  next `up -d` recreates the container and succeeds. Durable fix:
  `loginctl enable-linger burglar` so `/run/user/1000` survives logout/reboot;
  after a session restart, prefer `docker compose down` then `up -d postgres`
  (volumes are untouched by `down`).
