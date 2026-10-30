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
| api | 0.25 | 256 MB | V8 heap capped at 192 MB, pg pool 10 |
| api-2 | 0.25 | 256 MB | V8 heap capped at 192 MB, pg pool 10; api total 0.5 / 512 MB |
| postgres | 0.3 | 512 MB | `max_connections=40`, `shared_buffers=192MB`, `effective_cache_size=768MB` |
| reporting | 0.05 | 256 MB | V8 heap capped at 192 MB |
| settlement | 0.05 | 128 MB | |
| web (nginx) | 0.1 | 64 MB | |
| **long-running total** | **1.0** | **1472 MB** | the rest of 2 GB is left to the host |
| migrate (one-off, at boot) | 0.25 | 256 MB | runs before the services start |
| seed (one-off, by hand) | 0.5 | 512 MB | run it while the box is idle |

The api replicas and reporting run `node --import tsx` directly, so no npm
or tsx wrapper process uses memory. Web gzips text assets and caches hashed
asset files for a year; index.html fallbacks must be revalidated.

nginx balances the two replicas with `least_conn` because requests vary in
length. Only GETs and requests that never reached an api are retried on the
other replica; pay is never retried. The webhook dispatcher runs on `api`
only, switched off on `api-2` by `WEBHOOK_DISPATCHER_ENABLED=false`. Rolling
deploys build first, then migrate, then update `api` with `--wait`, then
`api-2` with `--wait`, then settlement and reporting, then web.

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
already opened a checkout can still pay until 30 are in flight. An
unreachable pair of api replicas gets the same `503` after the upstream
attempts fail. The static pages keep serving either way.

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
reboot. Each api replica's healthcheck probes `/readyz`; `web` starts once both
are healthy. Postgres keeps its data in the `filspay_pgdata` volume across
restarts. A `docker stop` or `docker kill` counts as a manual stop, which
Docker never restarts on its own; start it again with
`docker compose -f ops/docker-compose.yml up -d`.

**Capacity.** Measured on 30 Oct 2026 on a box of exactly the judged size
(DigitalOcean `s-1vcpu-2gb`: 1 vCPU, 2 GB, 50 GB) running this file, behind
the host nginx and TLS of `ops/host-nginx.conf`, with a copy of the hosted
database. The load came from a separate machine through the public https URL,
with `ops/loadtest/checkout.js`: each virtual user is a buyer whose checkout
is create link (merchant API key), open link, pay, then one second of
thinking. The sandbox acquirer adds 100 to 400 ms to every pay and fails a
share of them on purpose (`ACQUIRER_FAILURE_RATE`); those come back as 402
declines or 502 `acquirer_unavailable` and are counted apart from failures.
The JSON summary of every run is in `ops/loadtest/results/`.

| Run | Users | Requests/s | Paid checkouts/s | Failed | Shed (429/503) | p95 | p99 |
|---|---|---|---|---|---|---|---|
| Before this change: one api, npm and tsx wrappers (`before-30`) | 30 | 42.5 | 13.2 | 0.37% (acquirer 502s, then not split out) | 132 | 1.29 s | 1.85 s |
| **Claimed capacity** (`x30`, 3 min) | **30** | **43.9** | **13.8** | **0%** (33 acquirer 502s, no gateway error) | 117 (1.5%) | **1.21 s** | 1.61 s |
| Twice the claim (`x60`, 2 min) | 60 | 67.5 | 12.0 | 0% | 3,299 x 503 | 1.48 s | 1.89 s |
| Claim, `docker kill` of api-2 at 60 s (`xkill`) | 30 | 38.1 | 11.5 | 0.20% (14 x 504 in flight on the killed replica) | 291 | 1.43 s | 1.92 s |
| Claim, `kill -9` of api-2's node at 60 s (`xcrash`) | 30 | 36.3 | 10.8 | 0.17% (11 x 504 in flight) | 333 | 1.60 s | 2.17 s |
| Claim, rolling deploy of new images during the run (`xdeploy`) | 30 | 32.5 | 9.5 | 0% | 466 x 503 | 1.90 s | 2.40 s |
| Claim, full box reboot at 60 s (`xreboot`) | 30 | | | the 44 s outage: 236 x 502 and 286 connection errors from the host while the stack was down | 498 | | |

So the box carries 30 buyers at once, about 44 requests and 14 paid checkouts
a second, with p95 near 1.2 s. Past that it does not slow down or break: at
twice the load every extra request gets an immediate 503 with `Retry-After`,
paid checkouts stay at 12 a second, and nothing restarts or runs out of
memory. A crashed replica costs only the requests it was holding (each pay
among them answers 504 `payment_outcome_unknown`, never a blind retry); the
other replica carries the load and Docker has the crashed one healthy again
in 18 s. During a deploy `/readyz` answered 200 on all 381 polls (every 0.5 s,
four minutes); the extra 503s in that run are the image build sharing the one
vCPU, not the replica swap. A full reboot under load had every service healthy
44 s later, and none of the 1,891 pays it had acknowledged was lost (4 more
were committed as the box went down, so their buyers saw an error but the link
shows paid). After every run the data checks held: each acknowledged pay is
paid in the database with a fully captured transaction, no transaction
belongs to two links, and every ledger group balances.

**Per-address limits** (in `ops/nginx.conf`, keyed on the real client address
taken from the host nginx's `X-Forwarded-For`; a client cannot spoof it):
checkout open and pay 100 requests a second with a burst of 200, every other
api route 100 a second with a burst of 200, login and OTP 10 a minute with a
burst of 10. One address sending 150 requests a second for 20 s got 1,918
through, 834 x 429 and 249 x 503. The per-address rates are high on purpose:
everyone behind one NAT (an office, a venue's Wi-Fi) shares one address. The
in-flight caps (20, and 30 for pay) are what protect the box.

**Memory budget** (docker stats, MiB; host total 1,967 MB plus a 2 GB
swapfile as a backstop):

| Container | Limit | Idle before | Idle after | At 30 users after |
|---|---|---|---|---|
| api | 256 (was 512) | 85.6 | 74.7 | 65.5 |
| api-2 | 256 | | 47.6 | 60.9 |
| postgres | 512 | 73.4 | 35.5 | 116.5 |
| reporting | 256 | 76.8 | 32.8 | 34.1 |
| web | 64 | 10.5 | 4.2 | 4.6 |
| settlement | 128 | 1.6 | 1.2 | 1.2 |
| **total** | **1,472** | **248** | **196** | **283** |

Inside each api container the process tree went from `npm exec` (67 MB RSS)
plus `sh` plus the `tsx` wrapper (47 MB) plus node (93 MB), to node alone
(89 MB) plus tsx's esbuild helper (17 MB), so two replicas now cost what one
did.

**Deploys.** `ops/deploy.sh` is what the box runs for each commit: it backs up
the database, builds every image while the old containers keep serving, then
replaces migrate, api, api-2, settlement and reporting, and web, one at a
time, waiting on each api's healthcheck before the next, and rolls back to the
previous commit if the public smoke test fails. `ops/host-nginx.conf` is the
host's TLS site: http/2, a keepalive pool to `web`, and the app's own
security headers passed through once.

**From a fresh clone:**

```
git clone <repo> fils-pay && cd fils-pay
cp ops/.env.docker.example ops/.env.docker
# edit ops/.env.docker: set every secret, and CHECKOUT_BASE_URL to the
# public https origin
# Host nginx owns port 80 on the Dilmune box, so publish web on loopback
# and point the host's site at http://127.0.0.1:8080 (TLS on the host):
export FILSPAY_HTTP_PUBLISH=127.0.0.1:8080
docker compose -f ops/docker-compose.yml build
docker compose -f ops/docker-compose.yml up -d --wait postgres
docker compose -f ops/docker-compose.yml run --rm --no-deps migrate
docker compose -f ops/docker-compose.yml up -d --no-deps --wait api
docker compose -f ops/docker-compose.yml up -d --no-deps --wait api-2
docker compose -f ops/docker-compose.yml up -d --no-deps settlement reporting
docker compose -f ops/docker-compose.yml up -d --no-deps --wait web
docker compose -f ops/docker-compose.yml ps        # both api replicas healthy, web up
curl -fsS http://127.0.0.1:8080/readyz
```

Without a host nginx, leave `FILSPAY_HTTP_PUBLISH` unset and `web` takes
port 80 directly. Never `down -v` on the box: it deletes the database
volume.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try
