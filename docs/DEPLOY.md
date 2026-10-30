# Deploying FilsPay to Dilmun Cloud

I could not find public documentation for Dilmun / Dilmune Cloud, so this
follows the settings already recorded in `INVESTIGATE.md` (install `npm ci`,
build `npm run build`, output `apps/web/dist`). Check field names against the
platform's dashboard; nothing here has been run on Dilmun itself.

## What runs where

| Piece | Kind | Build | Start / output |
|---|---|---|---|
| `apps/web` (merchant dashboard + checkout) | static site | `npm ci` then `npm run build` | publish `apps/web/dist` |
| `apps/admin` (internal console) | static site | `npm ci` then `npm run build --workspace @filspay/admin` | publish `apps/admin/dist` |
| `apps/api` | long-running Node 22 service | `npm ci` | `npm run start --workspace @filspay/api` (port `3000`) |
| PostgreSQL 16 | managed database | - | run `npm run migrate` once per release |

The static sites need no server, but they are useless without the API and the
database, so the API and Postgres must exist before the dashboards can work.
`apps/settlement` (Go) and `apps/reporting` are separate workers; deploy them
once the API is up (`ops/docker-compose.yml` shows how they connect).

## 1. Database

Create a Postgres 16 instance, then from a machine that can reach it:

```sh
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/filspay?sslmode=require" npm run migrate
```

Do not run `npm run seed` against anything but a throwaway database.

## 2. API environment

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | enables the production guards below |
| `DATABASE_URL` | connection string from step 1 |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | base64 of 32 random bytes: `openssl rand -base64 32` |
| `ACQUIRER_CALLBACK_SIGNING_SECRET` | required in production; callbacks must be signed |
| `SETTLEMENT_INTERNAL_TOKEN` | required in production |
| `SETTLEMENT_INTERNAL_URL` | internal URL of the settlement worker |
| `CORS_ALLOWED_ORIGINS` | comma-separated deployed web/admin origins, e.g. `https://pay.example.com,https://admin.example.com` |
| `CHECKOUT_BASE_URL` | the deployed web origin (used to build payment-link URLs) |

Generate fresh secrets. The sandbox value in `ops/.env.docker` was committed
to Git and must be treated as exposed.

## 3. Web and admin

Set the API URL **at build time** (Vite inlines it):

```sh
VITE_API_BASE_URL=https://api.example.com npm run build
```

The sites are single-page apps: configure the host to serve `index.html` for
unknown paths (e.g. `/pay/:token`, `/transactions/:id`), otherwise deep links
404. Cookies are `credentials: include`, so web, admin and API must be on
HTTPS and the API origin must be listed in `CORS_ALLOWED_ORIGINS`.

## 4. Check it

```sh
curl https://api.example.com/health
```

Then sign in to the dashboard, capture a test payment, and refund it.
