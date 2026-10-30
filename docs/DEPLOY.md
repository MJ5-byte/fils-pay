# Deploying FilsPay to Dilmun Cloud

The hosted demo is one Dilmun server (`ShadowStack`, 1 vCPU / 2 GB) with
Dilmun-managed Postgres 16 and nginx, and three sites:

| Site | Kind | Build command | Output / runtime |
|---|---|---|---|
| `fp-pay-tzakir.dilmune.app` (`apps/web`: dashboard + checkout) | static | `VITE_API_BASE_URL=https://fp-api-tzakir.dilmune.app npm run build --workspace @filspay/web` | `apps/web/dist` |
| `fp-admin-tzakir.dilmune.app` (`apps/admin`) | static | `VITE_ADMIN_API_BASE_URL=https://fp-api-tzakir.dilmune.app VITE_WEB_BASE_URL=https://fp-pay-tzakir.dilmune.app npm run build --workspace @filspay/admin` | `apps/admin/dist` |
| `fp-api-tzakir.dilmune.app` (`apps/api` + settlement + reporting) | nginx reverse proxy to `127.0.0.1:3000` | none (code checkout only) | systemd, via `ops/dilmune/setup.sh` |

Install command for all three: `npm ci --include=dev`.

The `VITE_*` values stay in the build commands because Dilmun only passes a
site's Environment variables to the build when "env in deploy" is on for
that site. Vite inlines them at build time, so a missing value silently
becomes `http://localhost:3000`. After every frontend deploy, check the
bundle:

```sh
curl -s https://fp-pay-tzakir.dilmune.app/ | grep -o '/assets/[^"]*\.js' \
  | head -1 | xargs -I{} curl -s https://fp-pay-tzakir.dilmune.app{} \
  | grep -o 'https://fp-api-tzakir.dilmune.app' | head -1
```

## nginx

Dilmun's default static template ends in `try_files $uri $uri/ =404`,
which breaks every client-side route (`/pay/:token`, `/dashboard/login`).
Both frontends use `try_files $uri $uri/ /index.html`, `no-cache` on
`index.html` and long-lived caching on `/assets/`.

The API site must be a reverse proxy. Its site root is the repository
checkout: as a static site it would serve every file in the repo.

## API environment (fp-api site)

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | enables the production guards below |
| `DATABASE_URL` | `postgres://filspay_admin:<password>@127.0.0.1:5432/filspay` |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | base64 of 32 random bytes: `openssl rand -base64 32` |
| `ACQUIRER_CALLBACK_SIGNING_SECRET` | required in production |
| `SETTLEMENT_INTERNAL_TOKEN` | required in production; shared by api and settlement |
| `SETTLEMENT_INTERNAL_URL=http://127.0.0.1:8091` | the default (`http://settlement:8091`) is the compose hostname |
| `CORS_ALLOWED_ORIGINS` | `https://fp-pay-tzakir.dilmune.app,https://fp-admin-tzakir.dilmune.app` |
| `CHECKOUT_BASE_URL` | `https://fp-pay-tzakir.dilmune.app` (used in payment-link URLs) |
| `TZ=Asia/Bahrain` | settlement business day |
| `KYC_UPLOAD_DIR` | outside the checkout, e.g. `/home/dilmune/filspay-data/kyc` |
| `LOAD_SHED_MAX_INFLIGHT` | optional, default 10 |

Generate fresh secrets for every environment. `ops/.env.docker` was
committed with a sandbox secret and must be treated as exposed.

## Deploy steps

1. Deploy the fp-api site (pulls the code).
2. Make sure `.env` exists in the site root: turn on "env in deploy" for the
   site, or copy the variables above into it by hand.
3. From the site root: `bash ops/dilmune/setup.sh`. It checks the required
   variables, applies migrations, builds the Go settlement binary
   (installing Go 1.22 to `~/.local/go` if needed) and (re)starts three
   systemd services: `filspay-api` (0.5 vCPU / 512 MB), `filspay-settlement`
   (internal API on 127.0.0.1:8091) and `filspay-reporting`. It exits
   non-zero unless all three are active and `/readyz` answers.
4. Deploy fp-pay and fp-admin, then run the bundle check above.

Never run `npm run seed` here: it truncates merchants, transactions and the
ledger.

## Check it

```sh
curl https://fp-api-tzakir.dilmune.app/healthz   # process is up
curl https://fp-api-tzakir.dilmune.app/readyz    # database reachable
```

Then sign in to the dashboard, capture a test payment, and refund it.

## Known platform issues (Oct 2026)

- The server was provisioned while a package install held the dpkg lock,
  so nginx was missing when the sites were created (`site_create_failed:
  sudo: nginx: command not found`). nginx was installed later, but Dilmun
  never created the `*.dilmune.app` DNS records or certificates for the
  three sites, and it still reports them `active` with `sslEnabled: true`.
  `retry_site` refuses (not in error state) and `*.dilmune.app` names can't
  be added as managed domains. Needs Dilmun support or recreating the sites.
- The firewall allows Postgres (5432) from anywhere and `pg_hba.conf`
  accepts `0.0.0.0/0`. Nothing needs remote access; remove both.

Capacity numbers: `docs/CAPACITY.md`.
