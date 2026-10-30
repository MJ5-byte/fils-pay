# FilsPay: every route

Every HTTP route, CLI entry and page, built from registration calls, hooks and handler bodies, never from comments.
API paths drop `apps/api/src/`. "Gate" is what the code enforces beyond authentication. Tickets are tags from
`team-filspay.md`, not re-judged there.

## 1. API (`apps/api/src`)

`index.ts:16` calls `buildApp` (`app.ts:41`), which registers every route below (`app.ts:53-76`); `index.ts:31` starts
the webhook dispatcher. No CORS, rate-limit or helmet plugin (BHA-52). No global hooks: every guard is a per-route
`preHandler`. Errors go through `plugins/errorHandler.ts`. The `v1/` source tree is dead: nothing imports it.

Auth key:
- **MS** `requireSession` (`auth/middleware.ts:30`): merchant cookie `fp_sid`, read through view `live_sessions`,
  which does not check `authenticated` (BHA-11).
- **MA** `requireMerchantAuth` (`auth/requireMerchantAuth.ts:46`): session cookie, then `Authorization: Bearer` API
  key, then the impersonation grant cookie.
- **KEY** `requireApiKey` (`apiKeys/verify.ts:34`): API key only.
- **AS** `requireAdminSession` (`adminAuth/middleware.ts:33`): admin cookie; this lookup does check `authenticated`.
- **role(...)**: `requireRole` (`auth/middleware.ts:46`), `requireMerchantRole` (`requireMerchantAuth.ts:149`, API keys
  always pass) or `requireAdminRole` (`adminAuth/middleware.ts:57`). **own**: `assertOwnMerchant`, the path merchant
  equals the caller's, checked in the handler.

### 1a. Health and public

| Method | Path | Auth | Gate | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|---|---|
| GET | /healthz | none | none | routes/health.ts:13 | liveness | no | |
| GET | /readyz | none | none | routes/health.ts:21 | 200 once the DB connected at boot, never rechecked | no | |
| POST | /v1/merchants | none | none, public signup | routes/businessProfile.ts:20 | creates a merchant and its owner; any existing email can sign up again | no | BHA-39 |
| GET | /v1/payment-links/:token | none | none | routes/paymentLinks.ts:143 | public link view, includes the key hash | no | BHA-37 |
| POST | /v1/payment-links/:token/pay | none | `Idempotency-Key` header; client `submittedAt` honoured | routes/paymentLinks.ts:155 | authorizes and captures the link amount | yes | BHA-7, BHA-8, BHA-32 |
| POST | /v1/acquirer/callbacks | signature | skipped when the header is absent unless `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE`; `outcome` unchecked | routes/acquirerCallbacks.ts:41 | appends a note, never touches status or ledger | no | BHA-14, BHA-16, BHA-36 |

### 1b. Merchant auth (`/v1/auth`, `routes/auth.ts`)

| Method | Path | Auth | Gate | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|---|---|
| POST | /v1/auth/login | none | password; OTP recipient found by email across all merchants | auth.ts:54 | pending cookie plus OTP (code in the response with dev expose) | no | BHA-39 |
| POST | /v1/auth/otp/verify | pending cookie | attempt counter, racy | auth.ts:118 | promotes the session | no | BHA-11 |
| POST | /v1/auth/otp/resend | pending cookie | 30 s spacing only | auth.ts:199 | new OTP, resets attempts | no | BHA-11 |
| GET | /v1/auth/me | MS | none | auth.ts:255 | identity; answers 200 on a pending session | no | BHA-11 |
| POST | /v1/auth/logout | MS | none | auth.ts:292 | revokes the session | no | |

### 1c. Merchant self-service (`/v1/merchants/:merchantId/...`, all "own")

| Method | Path | Auth | Gate | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|---|---|
| GET | .../business-profile | MS | own | routes/businessProfile.ts:49 | read profile | no | |
| PATCH | .../business-profile | MS | role(owner,finance) | businessProfile.ts:59 | update profile | no | |
| POST | .../kyc/documents | MS | role(owner,finance) | routes/kyc.ts:38 | upload; keeps the last file part; PDF by filename | no | BHA-28 |
| GET | .../kyc/documents | MS | own | kyc.ts:79 | list | no | |
| GET | .../kyc/documents/:documentId/file | MS | role(owner,finance) | kyc.ts:88 | download | no | |
| GET | .../kyc/documents/:documentId/thumbnail | MS | role(owner,finance) | kyc.ts:105 | thumbnail | no | |
| POST | .../api-keys | MS | role(owner) | routes/apiKeys.ts:32 | issue key, raw shown once | no | |
| GET | .../api-keys | MS | role(owner) | apiKeys.ts:54 | list | no | |
| DELETE | .../api-keys/:id | MS | role(owner) | apiKeys.ts:63 | revoke | no | |
| POST | .../payment-links | MA | role(owner,finance) | paymentLinks.ts:76 | create link, `Math.random` token | no | BHA-35 |
| DELETE | .../payment-links/:id | MA | role(owner,finance); path only, the cancel query has no merchant | paymentLinks.ts:100 | cancel link | no | BHA-12 |
| GET | .../payment-links | MA | own | paymentLinks.ts:119 | list | no | |
| POST | .../webhook-endpoints | MA | role(owner,finance); any URL | routes/webhooks.ts:56 | create, secret shown once | no | BHA-36 |
| GET | .../webhook-endpoints | MA | role(owner,finance) | webhooks.ts:88 | list | no | |
| DELETE | .../webhook-endpoints/:id | MA | role(owner,finance) | webhooks.ts:102 | delete; fails its FK with history | no | BHA-36 |
| PATCH | .../webhook-endpoints/:id | MA | role(owner,finance) | webhooks.ts:120 | url or status | no | |
| POST | .../webhook-endpoints/:id/test | MA | role(owner,finance) | webhooks.ts:142 | signed test send, echoes 2 KB of the response | no | BHA-15, BHA-36 |
| POST | .../webhook-endpoints/:id/deliveries/:deliveryId/replay | MA | role(owner,finance) | webhooks.ts:163 | queue a replay | no | BHA-34 |
| GET | .../webhook-endpoints/:id/deliveries | MA | role(owner,finance,support) | webhooks.ts:180 | list deliveries | no | |
| GET | .../webhook-endpoints/:id/deliveries/:deliveryId | MA | role(owner,finance,support) | webhooks.ts:216 | payload and signature | no | |

### 1d. Transactions, refunds, settlement, analytics, reporting

Reads scope by the caller's merchant from the auth context, not the path.

| Method | Path | Auth | Gate | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|---|---|
| POST | /v1/transactions | KEY | `Idempotency-Key` header | routes/transactions.ts:67 | authorize: acquirer call, transaction, 7-day hold | hold | BHA-38 |
| POST | /v1/transactions/:id/capture | MA | none, impersonation passes; merchant-scoped in `capture.ts` | transactions.ts:90 | capture plus ledger; discount applied after | yes | BHA-33, BHA-40 |
| POST | /v1/transactions/:id/void | MA | none, impersonation passes | transactions.ts:120 | void, releases the hold | yes | BHA-40 |
| GET | /v1/transactions | MA | none | transactions.ts:134 | keyset list | no | |
| GET | /v1/transactions/export | MA | none | transactions.ts:154 | CSV built in memory | no | BHA-28 |
| GET | /v1/transactions/:id | MA | merchant-scoped | transactions.ts:175 | detail | no | |
| GET | /v1/transactions/:id/events | MA | detail lookup first | transactions.ts:190 | timeline | no | |
| POST | /v1/refunds | MA | none | routes/refunds.ts:23 | always 501 | stub | BHA-6, BHA-31 |
| GET | /v1/settlement/batches | MA | none | routes/settlement.ts:38 | list batches | no | |
| GET | /v1/settlement/reconciliation | MA | role(owner,finance) | settlement.ts:59 | reconciliation, payouts subtracted twice | no | BHA-46 |
| GET | /v1/settlement/summary | MA | role(owner,finance) | settlement.ts:77 | summary, double counts multi-capture | no | BHA-27 |
| GET | /v1/settlement/batches/:id | MA | merchant-scoped | settlement.ts:94 | batch detail | no | |
| GET | /v1/settlement/batches/:id/transactions | MA | batch lookup first | settlement.ts:109 | batch transactions | no | |
| GET | /v1/analytics/volumes | MA | none | routes/analytics.ts:90 | daily volumes | no | |
| GET | /v1/analytics/payout-trends | MA | none | analytics.ts:99 | payout trends | no | BHA-45 |
| GET | /v1/analytics/recent-ledger-activity | MA | none | analytics.ts:108 | recent ledger rows | no | |
| GET | /v1/analytics/top-links | MA | none | analytics.ts:117 | top links | no | |
| GET | /v1/reporting/transactions | MA | `reporting/scope.ts:12-19` lets any merchant read a split child | routes/reporting.ts:24 | filtered report | no | BHA-42 |
| POST | /v1/reporting/saved-filters | MA | none | reporting.ts:52 | save filter | no | |
| GET | /v1/reporting/saved-filters | MA | none | reporting.ts:73 | list filters | no | |
| GET | /v1/reporting/export-summary | none | none; dereferences `request.merchantAuth!`, so always 500 | reporting.ts:79 | daily totals | no | BHA-46 |

### 1e. Admin (`/v1/admin`, roles support, finance, super_admin)

| Method | Path | Auth | Gate | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|---|---|
| POST | /v1/admin/auth/login | none | password | routes/adminAuth.ts:54 | pending session plus OTP | no | |
| POST | /v1/admin/auth/otp/verify | pending cookie | attempt counter, racy | adminAuth.ts:111 | promotes the session | no | BHA-11 |
| GET | /v1/admin/auth/me | AS | none | adminAuth.ts:196 | identity | no | |
| POST | /v1/admin/auth/logout | AS | none | adminAuth.ts:204 | revoke | no | |
| GET | /v1/admin/merchants | AS | any role | routes/adminMerchants.ts:89 | merchant list | no | |
| GET | /v1/admin/merchants/:id | AS | any role | adminMerchants.ts:112 | merchant detail | no | |
| POST | /v1/admin/merchants/:id/kyc-reviews | AS | role(finance,super_admin) | adminMerchants.ts:133 | approve or reject KYC | no | |
| POST | /v1/admin/merchants/:id/api-keys/:keyId/rotate | AS | role(finance,super_admin) | adminMerchants.ts:176 | new key, old one stays live | no | BHA-25 |
| POST | .../webhook-endpoints/:endpointId/replay-batch | AS | any role, by design | adminMerchants.ts:210 | batch replay | no | BHA-13, BHA-34 |
| POST | .../webhook-endpoints/:endpointId/archive | AS | any role, by design | adminMerchants.ts:256 | snapshot deliveries | no | BHA-13 |
| POST | .../archive/:archiveId/replay | AS | any role, by design | adminMerchants.ts:297 | restore an archive | no | BHA-13 |
| POST | /v1/admin/merchants/:id/impersonate | AS | any role; super_admin becomes owner (`impersonation.ts:85-89`) | adminMerchants.ts:327 | grant cookie | no | BHA-40 |
| POST | .../transactions/recompute-statuses | AS | role(finance,super_admin) | routes/adminMerchantsRecompute.ts:15 | rewrites statuses and `test_mode` | indirect | BHA-24 |
| POST | /v1/admin/merchants/bulk-approve | AS | role(finance,super_admin), max 200 | routes/adminMerchantsBulk.ts:20 | bulk KYC approve, no status check | no | BHA-41 |
| POST | /v1/admin/merchants/:id/balance-adjustments | AS | role(finance,super_admin) | routes/adminBalanceAdjustments.ts:58 | writes the balance cache only | cache | CONTESTED, ADR-0006 |
| POST | /v1/admin/merchants/:id/credits | AS | none | routes/adminCredits.ts:62 | credit request; below the threshold posts to the ledger at once | yes | BHA-13 |
| GET | /v1/admin/credits | AS | any role | adminCredits.ts:44 | credit queue | no | |
| POST | /v1/admin/credits/:creditRequestId/approve | AS | role(finance,super_admin); compares display names | adminCredits.ts:84 | approve, posts to ledger | yes | BHA-47 |
| POST | /v1/admin/credits/:creditRequestId/reject | AS | role(finance,super_admin) | adminCredits.ts:107 | reject | no | |
| POST | /v1/admin/adjustment-imports | AS | role(finance,super_admin) | routes/adminAdjustmentImport.ts:41 | parse CSV and apply per row, no dry run or dedupe | yes | BHA-10 |
| GET | /v1/admin/adjustment-imports | AS | any role | adminAdjustmentImport.ts:77 | history | no | |
| GET | /v1/admin/adjustment-imports/:id/rows | AS | any role | adminAdjustmentImport.ts:90 | row detail | no | |
| POST | /v1/admin/settlement/run-batch | AS | role(finance,super_admin) | routes/admin.ts:109 | calls settlement `/internal/run-batch` | yes | |
| POST | /v1/admin/balances/rebuild | AS | role(finance,super_admin) | admin.ts:170 | calls settlement `/internal/rebuild-balances` | cache | BHA-9 |
| POST | /v1/admin/reporting/rebuild | AS | role(finance,super_admin) | admin.ts:226 | in-process rollup rebuild, races the consumer | no | Codex lead |
| POST | /v1/admin/merchants/:id/mdr-recalculation | AS | role(finance,super_admin) | admin.ts:262 | calls settlement `/internal/recalculate-mdr` | yes | BHA-21 |
| POST | /v1/admin/impersonation/:grantId/end | AS | any role | admin.ts:327 | end grant | no | |

## 2. Settlement (`apps/settlement`)

### 2a. Internal HTTP (`internal/internalapi/server.go`)

`net/http` mux on `SETTLEMENT_INTERNAL_PORT` (8091), all interfaces (`server.go:135`), started only by `daemon`
(`main.go:84`), which refuses to start without `SETTLEMENT_INTERNAL_TOKEN` (`main.go:81`). `requireBearerToken`
(`server.go:170`) uses a constant-time compare and never accepts an empty token; it runs before `requirePost`, so an
unauthenticated GET gets 401, not the 405 the comment at `:117` claims. No health route.

| Method | Path | Handler | Does | Money | Ticket |
|---|---|---|---|---|---|
| POST | /internal/run-batch | `handleRunBatch` :209 | `RunDailyBatch(date, merchant?)`, closes and pays batches | yes | BHA-17, BHA-18, BHA-19 |
| POST | /internal/rebuild-balances | `handleRebuildBalances` :266 | `RefreshBalanceCache` from view `merchant_payable_position` | cache | BHA-9 |
| POST | /internal/recalculate-mdr | `handleRecalculateMDR` :296 | rewrites batches including paid ones, posts ledger rows | yes | BHA-21 |

Any other path answers 404, including `/internal/refund-adjustment`, which the API's
`admin/settlementClient.ts:292` posts to for refunds (no caller yet). That client also sends
`Math.round(amountFils / 10)`, dropping a decimal place. Both are FP-300 work (BHA-31).

### 2b. CLI (`cmd/settlement/main.go`)

| Subcommand | Line | Writes | Ticket |
|---|---|---|---|
| `daemon` | :68 | internal API plus the scheduler: `RunDailyBatch` for the previous UTC day (`daemon.go:80`), then payout notifications. Batches, events, scheme export lines, ledger, balance cache, outbox, `platform_stats` | BHA-17, BHA-19, BHA-23, BHA-26, BHA-48 |
| `run-batch --date= [--merchant=]` | :93 | one daemon pass plus `settlement.paid` outbox rows | BHA-17, BHA-18, BHA-19 |
| `rebuild-balances [--merchant=]` | :141 | sums the ledger into the balance cache; with `--merchant` (:154) only prints | BHA-9, BHA-46 |
| `export-scheme-file --batch= --out=` | :175 | a CSV file only | BHA-19 |

## 3. Reporting (`apps/reporting`)

No HTTP server. CLI at `src/index.ts:21`, default `worker`.

| Entry | Line | Writes | Ticket |
|---|---|---|---|
| `worker` | `cli/worker.ts:11` | LISTEN and poll consumer: daily volume, payout trends, cursor | BHA-45 |
| `catch-up` | `cli/catchUp.ts` | one-shot backfill into the same rollups and cursor, overlaps the worker | BHA-45 |
| `rebuild` | `cli/rebuild.ts:53-54` | truncates the rollups, resets the cursor, replays the outbox | |

## 4. Front ends

### 4a. Merchant web (`apps/web/src/router.tsx`)

API base `VITE_API_BASE_URL` or `http://localhost:3000`, cookies included (`api/client.ts:3,40`). No `/` route.
`RequireDashboardAuth` redirects only when `GET /v1/auth/me` fails, so a pending session gets in (BHA-11).
`RoleGatedPage` and `RequireRole` only hide UI.

| Path | Component | Guard | API calls |
|---|---|---|---|
| /pay/:token | CheckoutPage | none | GET /v1/payment-links/:token; POST .../pay with client `submittedAt` |
| /dashboard/login | LoginPage | none | POST /v1/auth/login, /otp/verify, /otp/resend |
| /dashboard | redirect to /dashboard/transactions | auth | |
| /dashboard/* layout | DashboardLayout | auth | GET /v1/auth/me; POST /v1/auth/logout |
| /dashboard/transactions | TransactionListPage | auth | GET /v1/transactions |
| /dashboard/transactions/:id | TransactionDetailPage | auth; capture and void hidden by role | GET /v1/transactions/:id and /events; POST .../capture, .../void |
| /dashboard/payment-links | PaymentLinkListPage | auth | GET .../payment-links |
| /dashboard/payment-links/new | PaymentLinkCreatePage | role(owner,finance) | POST .../payment-links |
| /dashboard/payment-links/:id | PaymentLinkDetailPage | auth | list lookup (no single-link endpoint); DELETE .../payment-links/:id |
| /dashboard/webhooks | WebhookEndpointListPage | role(owner,finance) | GET, PATCH, DELETE .../webhook-endpoints |
| /dashboard/webhooks/new | WebhookEndpointCreatePage | role(owner,finance) | POST .../webhook-endpoints |
| /dashboard/webhooks/:id | WebhookEndpointDetailPage | role(owner,finance) | list lookup; GET .../deliveries; POST .../replay |
| /dashboard/settlement | SettlementBatchListPage | auth | GET /v1/settlement/batches |
| /dashboard/settlement/:id | SettlementBatchDetailPage | auth | GET .../batches/:id and /transactions |
| /dashboard/reconciliation | ReconciliationPage | auth; only the nav link is role-hidden (`DashboardLayout.tsx:42-44`) | GET /v1/settlement/reconciliation |
| /dashboard/overview | OverviewPage | auth | GET /v1/analytics/volumes, /payout-trends, /top-links |

### 4b. Admin (`apps/admin/src/router.tsx`)

API base `VITE_ADMIN_API_BASE_URL` or `http://localhost:3000`. `RequireAdminAuth` redirects to `/login` when
`GET /v1/admin/auth/me` fails. `RequireRole` only hides UI.

| Path | Component | Guard | API calls |
|---|---|---|---|
| /login | LoginPage | none | POST /v1/admin/auth/login, /otp/verify |
| / | redirect to /merchants | auth | |
| layout | AdminLayout | auth | GET /v1/admin/auth/me; POST logout; POST /v1/admin/impersonation/:grantId/end |
| /merchants | MerchantListPage | auth; bulk approve role-hidden | GET /v1/admin/merchants; POST .../bulk-approve |
| /merchants/:id | MerchantDetailPage | auth; five blocks role-hidden, credits not | GET merchant; POST kyc-reviews, recompute-statuses, balance-adjustments, credits, api-keys rotate, impersonate |
| /credits | CreditsPage | auth; approve and reject role-hidden | GET /v1/admin/credits; POST approve, reject |
| /settlement | SettlementPage | auth; four blocks role-hidden | POST run-batch, balances/rebuild, reporting/rebuild, mdr-recalculation |
| /adjustment-imports | AdjustmentImportPage | auth; upload role-hidden | POST and GET /v1/admin/adjustment-imports; GET .../:id/rows |
| /webhooks, /webhooks/:merchantId | WebhookReplayPage | auth, any role | GET merchants; POST replay-batch |

## 5. Mismatches

Calls nothing serves:
- `web/src/pages/transactions/RefundDrawer.tsx:65` posts `POST /v1/merchants/:merchantId/refunds`; the only refund
  route is `POST /v1/refunds` (501). Nothing renders the drawer (`TransactionDetailPage.tsx:30`). FP-300 picks the path.
- `admin/settlementClient.ts:292` posts `/internal/refund-adjustment`, which settlement does not serve (section 2a).

Routes no UI calls (server-to-server ones aside: `POST /v1/transactions`, callbacks, health):
- Merchant: signup, business profile, all KYC, all API key routes, `/v1/transactions/export`,
  `/v1/settlement/summary`, `/v1/analytics/recent-ledger-activity`, webhook test send, single delivery, all of
  `/v1/reporting/*`, `/v1/refunds`.
- Admin: webhook archive and archive replay.

No route is registered twice.

Comments that claim a guard the code lacks (planted or stale; the code wins):
- `routes/apiKeys.ts:35` "requireSession checks authenticated" (BHA-11).
- `routes/transactions.ts:92-93`, `requireMerchantAuth.ts:29` "impersonation is read-only" (BHA-40).
- `app.ts:71-72`, `routes/acquirerCallbacks.ts:37-38` "unsigned requests are rejected" (BHA-14).
- `routes/kyc.ts:36` "PDF on magic bytes", `plugins/multipart.ts:13` "one file per request" (BHA-28).
- `routes/webhooks.ts:103-104` "ON DELETE CASCADE added in 0047" (0047 is `merchant_discount_bps`), `:146` "private
  hosts blocked" (BHA-36).
- `routes/admin.ts:263-265` "MDR recalculation skips paid batches" (BHA-21).
- `routes/adminAdjustmentImport.ts:56-58`, `adjustmentImport.ts:62` "3dp parsed correctly", "re-upload blocked by a
  unique filename" (BHA-10; 0065 has no unique).
- `routes/reporting.ts` header "requireMerchantAuth only" over the unguarded `/export-summary` (BHA-46).
- `admin/src/router.tsx:12` "/v2 routes behind VITE_ADMIN_V2": neither exists.
- `routes/businessProfile.ts:18-19`: MK calls per-merchant emails "by design"; with the login lookup that is BHA-39.

## Not settled from the code

- Whether `listTransactionEvents` and `listBatchTransactions` need their own merchant filter (judged safe: the
  ownership lookup runs first).
- The credit threshold that decides auto-post versus approval (finance rule, UNPROVEN in `team-filspay.md`).
- The full write list of `RunDailyBatch` (taken from INSERT and UPDATE lines, not a full read of `batch.go`).
