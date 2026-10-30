# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting), and a `web`
front door that serves apps/web and apps/admin and proxies the api. The
hosted demo instance uses the same compose file with a different `.env`.

## Before the first run

Copy the template and fill in every value. The stack boots in production
mode, so the required secrets must be present or api and settlement
crash-loop at boot:

```
cp ops/.env.docker.example ops/.env.docker
# then edit ops/.env.docker and set every variable
```

`ops/.env.docker` is tracked in git with placeholders only, so each host
fills in its own copy and real values never go into a commit. On a public
host rotate `ACQUIRER_CALLBACK_SIGNING_SECRET` away from any value that was
ever committed (see BHA-51) and set it there.

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

For development, apps/web and apps/admin are plain Vite dev servers that
talk to apps/api over HTTP (`npm run dev` inside each package); neither has
a database connection of its own. On the hosted box the `web` service
serves their production builds instead (see "Hosted box").

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.docker.example` | template for `.env.docker`; placeholder names only, tracked in git |
| `.env.docker` | shared service settings and secrets, loaded by compose via `env_file`; tracked with placeholders only, each host overwrites it from the template and fills in real values |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:20.18`, full install) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` |
| `Dockerfile.web` | builds apps/web and apps/admin, serves them from nginx |
| `nginx.conf` | the `web` front door: routing, api proxy, overload refusals |

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
| api | `CARD_FINGERPRINT_KEY` | when `NODE_ENV=production`, must base64-decode to 32 bytes | `.env.docker` | no, throws at boot |
| api | `NODE_ENV=production` | hosted box | `.env.docker` | yes, but dev mode leaks OTP codes and uses a dev webhook key |
| api | `OTP_DEV_EXPOSE=false` | hosted box | `.env.docker` | yes, but every login response carries its OTP code; the API logs a warning at boot |
| api | `OTP_EXPOSE_EMAIL_DOMAINS=filspay.test,alpharetail.example,betadigital.example,gammahospitality.example,deltawholesale.example,deltamarketplace.example,coralbaytraders.example,palmgroveretail.example,seefkiosk.example` | hosted box, until an email or SMS provider exists | `.env.docker` | yes, but nobody can log in: production delivers no code, so only these seeded demo domains see theirs on the login screen |
| api, settlement | `SETTLEMENT_INTERNAL_TOKEN` | when `NODE_ENV=production`; no default | `.env.docker` | no, both crash-loop |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET` | when `NODE_ENV=production` | `.env.docker` | no, throws at boot |
| api | `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true` | hosted box | `.env.docker` | yes, but unsigned acquirer callbacks are accepted |
| api | `CORS_ALLOWED_ORIGINS` | once web/admin are hosted | `.env.docker` | yes, but browser calls from other origins are blocked |
| settlement | `DATABASE_URL` | always | `environment:` | no |
| reporting | `DATABASE_URL` | always | `environment:`; runs `worker` by default | no |

## Hosted box

The judged box is 1 vCPU and 2 GB for the whole stack, with the api held to
0.5 vCPU and 512 MB. Our Dilmune box is bigger (2 vCPU, 4 GB), so the
limits live in `docker-compose.yml` itself (`cpus` and `mem_limit` per
service, which a plain `docker compose up` applies) and hold the same on
any host:

| Service | CPU | Memory | Notes |
|---|---|---|---|
| api | 0.5 | 512 MB | V8 heap capped at 320 MB, pg pool 20 |
| postgres | 0.3 | 512 MB | `max_connections=50`, `shared_buffers=128MB` |
| reporting | 0.05 | 256 MB | V8 heap capped at 160 MB |
| settlement | 0.05 | 128 MB | |
| web (nginx) | 0.1 | 64 MB | |
| **long-running total** | **1.0** | **1472 MB** | the rest of 2 GB is left to the host |
| migrate (one-off, at boot) | 0.25 | 256 MB | runs before the services start |
| seed (one-off, by hand) | 0.5 | 512 MB | run it while the box is idle |

**One origin.** Everything is served by `web` on port 80, so the session
cookies (`fp_sid`, `fp_admin_sid`, `fp_impersonation`) are first-party
for both front ends and no CORS is involved:

| Path | Goes to |
|---|---|
| `/v1/*`, `/healthz`, `/readyz` | apps/api |
| `/` | redirects to `/dashboard` |
| `/dashboard/*`, `/pay/:token` | apps/web (merchant dashboard, hosted checkout) |
| `/login`, `/merchants`, `/credits`, ... | apps/admin |

Both apps are built with an empty API base URL, so they call `/v1/...` on
their own origin. apps/web is built with Vite base `/web/` so its assets
don't collide with apps/admin's `/assets/`. In production the api sets
`Secure` cookies, so the box must be reached over https: the host's own
nginx terminates TLS and proxies to `web`.

**Overload.** `web` counts api requests in flight. Past 20, a new
checkout (any api call other than paying) gets an immediate `503` in the
api's own `{ error, message }` shape, with `Retry-After: 1`; a buyer who
already opened a checkout can still pay until 30 are in flight. A down or
restarting api gets the same `503` within about a second. The static
pages keep serving either way.

**Rate limits.** `web` also caps each client address: every api route at
100 requests a second (bursts to 200), and the three routes that send or
check a login code (`login`, `otp/verify`, `otp/resend`, merchant and
admin) at 10 a minute (bursts to 10). Opening a payment link and paying it
have their own allowance of 100 requests a second per address (bursts to
200), so new work from one address can never use up the allowance of
checkouts already under way. Past a cap the client gets `429`
`rate_limited` with `Retry-After`. The client address comes from
`X-Forwarded-For` past the private-range proxies in front of `web`.

**Restarts.** Every long-running service has `restart: unless-stopped`, so
Docker brings it back when it crashes or is OOM-killed, and after a host
reboot. The api's healthcheck probes `/readyz`; `web` starts once the api
is healthy. Postgres keeps its data in the `filspay_pgdata` volume across
restarts. A `docker stop` or `docker kill` counts as a manual stop, which
Docker never restarts on its own; start it again with
`docker compose -f ops/docker-compose.yml up -d`.

**Capacity** (measured locally under these limits, fixed checkout of
open link then pay, the acquirer simulator adds 100 to 400 ms per pay):
about 38 checkouts a second, pay p95 under 0.8 s, for up to about 20
buyers in flight at once. At 150 the excess is refused in under 0.1 s and
the ones admitted still pay with p95 under 1 s; the next run is clean.

**From a fresh clone:**

```
git clone <repo> fils-pay && cd fils-pay
cp ops/.env.docker.example ops/.env.docker
# edit ops/.env.docker: set every secret, and CHECKOUT_BASE_URL to the
# public https origin
# Host nginx owns port 80 on the Dilmune box, so publish web on loopback
# and point the host's site at http://127.0.0.1:8080 (TLS on the host):
export FILSPAY_HTTP_PUBLISH=127.0.0.1:8080
docker compose -f ops/docker-compose.yml up -d --build
docker compose -f ops/docker-compose.yml ps        # api healthy, web up
curl -fsS http://127.0.0.1:8080/readyz
```

Without a host nginx, leave `FILSPAY_HTTP_PUBLISH` unset and `web` takes
port 80 directly. Never `down -v` on the box: it deletes the database
volume.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try
