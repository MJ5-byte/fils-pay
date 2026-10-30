# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env`.

## Before the first run

Copy the template and fill in every value. The stack boots in production
mode, so the required secrets must be present or api and settlement
crash-loop at boot:

```
cp ops/.env.docker.example ops/.env.docker
# then edit ops/.env.docker and set every variable
```

`ops/.env.docker` is gitignored: keep real secrets out of git, and on a
public host rotate `ACQUIRER_CALLBACK_SIGNING_SECRET` away from any value
that was ever committed (see BHA-51) and set it there.

## Quick start

```
docker compose -f ops/docker-compose.yml --profile seed run --rm seed   # optional, resets fixture data
docker compose -f ops/docker-compose.yml up api settlement reporting     # migrate runs first, then the services
```

`migrate` is a startup dependency of api, settlement and reporting
(`service_completed_successfully`), so the services never start against a
half-migrated schema. The `seed` job is behind the `seed` profile so a bare
`up` never truncates and regenerates the fixture data. On a brand-new
database `migrate` currently stops partway (BHA-72); land that fix before a
fresh-DB deploy.

apps/web and apps/admin aren't part of this compose file — they're plain
Vite dev servers that talk to apps/api over HTTP (`npm run dev` inside
each package), not services with their own database connection.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.docker.example` | template for `.env.docker`; placeholder names only, tracked in git |
| `.env.docker` | shared service settings and secrets, loaded by compose via `env_file`; gitignored, created per host from the template |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:20.18`, full install) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` |

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. It only takes effect when
`DATABASE_URL` is unset.

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above — `db/seed/index.ts` truncates and regenerates its
fixture tables on every invocation; it doesn't need the volume removed
first.

## Required settings per service

All the secrets below are set in `ops/.env.docker` (from the template).
`DATABASE_URL` and `SETTLEMENT_INTERNAL_URL` are set in compose `environment:`.

| Service | Variable | Required | Source | Boots without it? |
|---|---|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | always | `environment:` | no |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY` | every environment, must base64-decode to 32 bytes | `.env.docker` | no, throws at boot |
| api | `NODE_ENV=production` | hosted box | `.env.docker` | yes, but dev mode leaks OTP codes and uses a dev webhook key |
| api, settlement | `SETTLEMENT_INTERNAL_TOKEN` | when `NODE_ENV=production`; no default | `.env.docker` | no, both crash-loop |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET` | when `NODE_ENV=production` | `.env.docker` | no, throws at boot |
| api | `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true` | hosted box | `.env.docker` | yes, but unsigned acquirer callbacks are accepted |
| api | `CORS_ALLOWED_ORIGINS` | once web/admin are hosted | `.env.docker` | yes, but browser calls from other origins are blocked |
| settlement | `DATABASE_URL` | always | `environment:` | no |
| reporting | `DATABASE_URL` | always | `environment:`; runs `worker` by default | no |

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try
