# FilsPay bug list

Found while testing locally, running the stack on localhost and deploying to Dilmun Cloud on 2026-10-30.
Every "Fixed" row was re-checked against the live server or the repo on
2026-10-30. "Open" rows say what is blocking them.

Status key: **Fixed** · **Mitigated** (exposure stopped, root cause still
needs action) · **Open**

## Summary

| # | Bug | Severity | Status |
|---|---|---|---|
| 1 | API site served the repo as static files (admin password downloadable) | Critical | Mitigated |
| 2 | Admin password and sandbox secret committed to git | Critical | Mitigated |
| 3 | Postgres port 5432 open to the internet | High | Open |
| 4 | `*.dilmune.app` DNS records never created | High | Fixed |
| 5 | No HTTPS (nothing on port 443) | High | Fixed |
| 6 | API, settlement and reporting not running | High | Fixed |
| 7 | `DATABASE_URL` holds a placeholder password | High | Fixed |
| 8 | Overlapping API deploys corrupted `node_modules` | High | Fixed |
| 9 | Frontend deep links (`/pay/:token`) returned 404 | High | Fixed |
| 10 | Checkout bundle called `http://localhost:3000` | High | Fixed |
| 11 | Reporting tests failed on a shared test database | Medium | Fixed |
| 12 | Local compose: settlement exits at boot (no token) | Medium | Fixed |
| 13 | Root helper scripts crashed (`require` in an ESM repo) | Medium | Fixed |
| 14 | Helper scripts pointed at old hostnames | Low | Fixed |
| 15 | `setup.sh` skipped migrations and reported success on failure | Medium | Fixed |
| 16 | Docs and comments contradicted the code | Medium | Fixed |
| 17 | Dilmun auto-deploy does not fire on push | Medium | Open |
| 18 | Dilmun reports sites `active` / `sslEnabled: true` when they are not | Low | Open (platform) |
| 19 | API dev webhook key was 34 bytes, so the API couldn't boot in dev without one | Medium | Fixed |
| 20 | Local compose ran every Node service as `NODE_ENV=production` | Medium | Fixed |
| 21 | Settlement logs "next check-in ~tomorrow" but re-runs every minute | Low | Open |

## Details

### 1. API site served the repo as static files — Mitigated
- **What:** `fp-api-tzakir.dilmune.app` was a static site rooted at the git
  checkout. `filspay-admin-login.txt` and `merchant-details.json` returned
  200 to anyone who requested them by server IP.
- **Fix:** nginx for the API site is now a reverse proxy to
  `127.0.0.1:3000`; no files are served.
- **Verified:** both files return 502 (proxy, API not running).
- **Still needed:** rotate the admin password (see #2). It was public.

### 2. Secrets committed to git — Mitigated
- **What:** `filspay-admin-login.txt` (admin email + password),
  `merchant-details.json`, `ops/.env.docker` (sandbox acquirer secret) and
  server scratch dumps were tracked.
- **Fix (150a8f8):** untracked and added to `.gitignore`; local copies kept.
  `merchant-details.example.json` added as a blank template.
- **Verified:** `git ls-files` returns none of them.
- **Still needed:** they remain in git history (2 commits). Rotate the admin
  password and the sandbox acquirer secret. Removing them from history
  needs a history rewrite and force-push (owner's decision).

### 3. Postgres open to the internet — Open
- **What:** firewall rule #4 allows 5432 from anywhere, and `pg_hba.conf`
  accepts `0.0.0.0/0`. Nothing needs remote access.
- **Verified:** port 5432 is reachable from outside.
- **Blocked:** deleting the rule was denied by the Claude Code permission
  check. Delete firewall rule #4 in the Dilmun dashboard.

### 4. DNS records missing — Fixed
- **What:** when the server was created, a Postgres install held the dpkg
  lock, so nginx was missing and all site creations failed
  (`site_create_failed: sudo: nginx: command not found`). For several
  hours none of the three hostnames resolved (health checks failed with
  curl exit 6).
- **Fix:** the records appeared on Dilmun's side later on 2026-10-30 (no
  change from us); all three now resolve to Cloudflare, which proxies to
  139.59.13.131.
- **Verified:** resolves via 8.8.8.8 and 1.1.1.1; plain HTTP reaches the
  origin.

### 5. No HTTPS — Fixed
- **What:** nothing listened on 443, so Cloudflare returned **521** for
  every `https://` request even after DNS worked.
- **Fix:** `enable_ssl` (auto-renew on) for all three sites issued
  Let's Encrypt certificates (valid to 2027-01-28).
- **Verified:** `https://fp-api-tzakir.dilmune.app/healthz` and `/readyz`
  return 200; CORS preflight from the admin origin returns 204; both
  frontends serve their app on `/`, deep links and login routes; HTTP
  redirects to HTTPS; the custom nginx configs (SPA fallback, API proxy)
  survived; `/filspay-admin-login.txt` and `/.env` return 404.

### 6. Services not running — Fixed
- **What:** `filspay-api`, `filspay-settlement`, `filspay-reporting` were
  inactive; `setup.sh` had never run successfully.
- **Fix:** after #7, one API deploy (5cf7328) then `bash ops/dilmune/setup.sh`:
  72 migrations applied, Go 1.22.12 installed, settlement built, three
  systemd services started, `setup: OK`.
- **Verified:** all three `active` with 0 restarts after a minute;
  `/healthz` and `/readyz` return 200 through nginx; CORS preflight from
  the admin site returns 204; settlement listens on `127.0.0.1:8091` only;
  ports 3000 and 8091 are closed from outside.

### 7. Placeholder database password — Fixed
- **What:** `DATABASE_URL` on the API site held `CHANGE_ME`, and the real
  `filspay_admin` password couldn't be recovered (Dilmun never returns it).
- **Fix:** reset the role's password on the server (temporary
  `local all postgres peer` line in `pg_hba.conf`, one `ALTER ROLE`, then
  the original file restored from a backup), and set the new
  `DATABASE_URL` on the API site.
- **Verified:** `pg_hba.conf` is byte-identical to the original; the new
  password logs in as `filspay_admin`; migrations ran with it.

### 8. Overlapping deploys corrupted `node_modules` — Fixed
- **What:** several API deploys ran at once (plus Dilmun's automatic
  retries). The site deploys in place, so concurrent `npm ci` runs deleted
  each other's files (`ENOTEMPTY`, missing `cross-env`, `esbuild`).
- **Fix:** waited for all deploys to stop, ran exactly one deploy.
- **Verified:** deploy `b69589cb` (commit 150a8f8) completed; `npm ls`
  clean; `argon2` and `pg` load.
- **Avoid:** start one deploy and wait for it to finish before starting
  another.

### 9. Deep links 404 — Fixed
- **What:** Dilmun's static template ends in `try_files $uri $uri/ =404`,
  so `/pay/:token`, `/dashboard/login` etc. returned 404.
- **Fix:** both frontends use `try_files $uri $uri/ /index.html`, with
  `no-cache` on `index.html` and 1-year caching on `/assets/`.
- **Verified:** `/pay/x` and `/merchants/x` return 200 with the app.

### 10. Checkout bundle pointed at localhost — Fixed
- **What:** fp-pay was last built before its build command got
  `VITE_API_BASE_URL`, so the live bundle used `http://localhost:3000`.
- **Fix:** redeployed.
- **Verified:** both bundles contain `https://fp-api-tzakir.dilmune.app`.

### 11. Reporting tests failed on a shared database — Fixed
- **What:** `apps/api/src/webhooks/archiveReplay.test.ts` inserted
  `transaction.captured` outbox events with `{}` payloads. The reporting
  consumer later read them and hit a NOT NULL violation on
  `merchant_daily_volume.merchant_id`. 4 reporting tests failed and the
  root `scripts/*.test.ts` never ran.
- **Fix (d976b5a):** the fixture now writes the producers' real payload
  shape, with the endpoint's `merchantId`.
- **Verified:** full suite on a fresh Postgres: 448 tests, 0 failures.

### 12. Local compose: settlement exits at boot — Fixed
- **What:** `daemon` requires `SETTLEMENT_INTERNAL_TOKEN`; compose didn't
  set it and claimed `ops/.env.docker` was loaded (it never was).
- **Fix (150a8f8):** token set on both `api` and `settlement`.
- **Verified:** `docker compose config` shows the token on both services.

### 13. Helper scripts crashed on launch — Fixed
- **What:** `create-merchant.js` and `check-admin-login.js` use `require`,
  but the root `package.json` sets `"type": "module"`.
- **Fix (150a8f8):** renamed to `.cjs`.
- **Verified:** both run; `create-merchant.cjs --dry-run` validates input.

### 14. Helper scripts used old hostnames — Fixed
- `filspay-api-tzakir` / `filspay-web-0siu-tzakir` → `fp-api-tzakir` /
  `fp-pay-tzakir` / `fp-admin-tzakir` (150a8f8).

### 15. `setup.sh` gaps — Fixed
- **What:** no migrations, no env validation, no KYC dir, exit 0 even when
  services failed, wrong "Dilmune writes .env" message.
- **Fix (150a8f8):** checks required variables, runs migrations, creates
  `KYC_UPLOAD_DIR`, exits non-zero unless all three services are active
  and `/readyz` answers.
- **Verified:** `bash -n` passes; on the server it correctly stopped at the
  bad password (#7) without touching anything else.

### 16. Docs and comments contradicted the code — Fixed (150a8f8)
| Claim | Reality |
|---|---|
| compose loads `ops/.env.docker` automatically | nothing reads it |
| `PGCONN_SETTLEMENT` is ignored while `DATABASE_URL` is set | it overrides `DATABASE_URL` |
| settlement token defaults to `dev-token` | no default; `daemon` exits |
| seed only truncates its own fixture tables | truncates merchants, transactions, ledger, admin users… |
| api never boots without `WEBHOOK_SECRET_ENCRYPTION_KEY` | dev fallback outside production |
| token required by every settlement subcommand | only `daemon` |
| health check is `/health` | `/healthz` and `/readyz` |
| hosted box is 0.5 vCPU / 2 GB disk, runs compose | 1 vCPU / 50 GB, runs systemd |

`docs/DEPLOY.md` rewritten for the actual Dilmun setup.

### 17. Auto-deploy does not fire — Open
- **What:** frontends have `autoDeploy: true`, but every deploy is
  `manual` and the push of 150a8f8 started none.
- **Next:** check the GitHub webhook / Dilmun GitHub app for the repo.
  Until then, deploy frontends manually after changes.

### 18. Misleading Dilmun status — Open (platform)
- Sites show `active`, `sslEnabled: true` and some deploys show
  `completed` with an error attached. Report to Dilmun support with #4.

### 19. Dev webhook key had the wrong length — Fixed
- **What:** `DEV_FALLBACK_WEBHOOK_KEY_B64` in `apps/api/src/config.ts`
  decoded to 34 bytes (`test-key-for-dev-only-not-for-prod`), but the key
  must be exactly 32. Every non-production start without an explicit key
  crashed with `must base64-decode to exactly 32 bytes, got 34`. Every test
  passed its own key, so none caught it.
- **Fix:** 32-byte dev key, plus `apps/api/src/config.test.ts` (fails on the
  old key, passes on the new one; production still requires a real key).
- **Verified:** full suite 452/452; API boots locally with no key set.

### 20. Local compose ran in production mode — Fixed
- **What:** `ops/Dockerfile.node` sets `NODE_ENV=production`, so the local
  `seed`, `api` and `reporting` containers demanded production secrets and
  `seed` failed (`SETTLEMENT_INTERNAL_TOKEN is required when
  NODE_ENV=production`).
- **Fix:** compose sets `NODE_ENV: development` on every Node service.
- **Verified:** migrate, seed, api, settlement and reporting all start;
  admin login, merchant login, authorize → capture → refund and the
  reporting rollup all work end to end on localhost.

### 21. Misleading settlement check-in log — Open
- **What:** on the server the daemon logs `RunDailyBatch(2026-10-29)
  processed 0 merchant(s)` and `next check-in ~<tomorrow>`, then repeats
  both a minute later (poll interval 1m). No harm seen (0 merchants, so
  nothing written twice), but the log contradicts the behaviour.
- **Next:** check `apps/settlement/internal/scheduler` to see whether the
  re-run is intended (idempotent poll) and fix whichever is wrong, the
  log or the loop.

## Incidents during the fix

- **node_modules deleted mid-install:** while clearing the corrupted
  `node_modules` (#8), a Dilmun auto-retry deploy was running; the delete
  made that retry fail. No lasting effect: it was already a failing
  deploy and nothing ran from that directory.
- **Local credential files deleted by a fast-forward:** checking out
  `main` (where the files were tracked) and fast-forwarding to 150a8f8
  (where they are untracked) removed the local copies. All six were
  restored from d976b5a and are gitignored.
