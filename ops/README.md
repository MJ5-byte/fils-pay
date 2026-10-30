# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
Dilmune box does not use compose; it runs systemd services installed by
`ops/dilmune/setup.sh` (see `docs/DEPLOY.md`).

## Quick start

```
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting
```

apps/web and apps/admin aren't part of this compose file — they're plain
Vite dev servers that talk to apps/api over HTTP (`npm run dev` inside
each package), not services with their own database connection.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:22-alpine`) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` (`golang:1.22-alpine` → distroless) |
| `dilmune/setup.sh` | systemd setup for the hosted Dilmune VM |

There is no shared env file: each service's settings are in its
`environment:` block. `ops/.env.docker` used to be committed with a sandbox
acquirer secret; it is now untracked and was never read by compose. Treat
that secret as exposed and rotate it with the acquirer sandbox.

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker also reads `PGCONN_SETTLEMENT`. When it is set it
**replaces** `DATABASE_URL` for that worker; compose leaves it unset.

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above. It truncates (with `CASCADE`) merchants,
transactions, the ledger, settlement batches, the outbox, admin users and
more, then regenerates fixtures. Only ever run it against this local
database.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL`, `SETTLEMENT_INTERNAL_TOKEN` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY`, `ACQUIRER_CALLBACK_SIGNING_SECRET` | required only with `NODE_ENV=production`; dev defaults otherwise |
| settlement | `DATABASE_URL`, `SETTLEMENT_INTERNAL_TOKEN` | `environment:`; `daemon` exits without the token |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

## Resource sizing

The hosted Dilmune VM is 1 vCPU / 2 GB RAM / 50 GB disk. `setup.sh` caps
the API at 0.5 vCPU / 512 MB, settlement at 0.25 vCPU / 256 MB and
reporting at 0.2 vCPU / 256 MB.
