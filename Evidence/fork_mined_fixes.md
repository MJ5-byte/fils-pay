# Fork-mined fixes

Execution date: 2026-10-30. Starting HEAD `c389b26`; branch `speedup/fork-mined-fixes`.
No merges or cherry-picks. Public reference objects fetched for read-only inspection.
The supplied report remains unmodified. Batches 2–8 are pending until recorded below.
Per user steering, use focused regression tests plus one relevant suite per batch;
repeat only to resolve failures or verify further changes.

## Batch 0 — migration boot blockers (BUG-014)

### Local status before
Confirmed: original migration runner fails at 0054 (42P01); 0055's columns do not match 0007.
### Local root cause
0054 refers to a nonexistent join table instead of transaction_events.settlement_batch_id.
0055 assumes code/account_type/description columns and a suspense kind not present in the actual schema.
### References inspected
Report's ali-afk `f2df1313ffeb6226b1d6e9d0a11dd1558919898c` runtime commit was checked;
it has no patch for these SQL files. These repairs derive from our actual 0007/0023 schema.
### Implementation adopted
Use existing settlement_batch_id; insert suspense accounts as asset accounts using id/name/kind.
### Local files changed
db/migrations/0054_views.sql; db/migrations/0055_chart_of_accounts_suspense.sql.
### Regression test / commands run
`npm run migrate` against new PostgreSQL 16.9: fails before, reaches 0072 afterward.
### Result
See fork-baseline-migrate.txt and fork-bootstrap-migrate.txt. Actual migration execution, not static enumeration only.
### Differences from reference
Independent minimal schema repairs. Historical-file exception explained in fork_mining_baseline.md.
### Remaining risk
No production deployment/migration history inspected. 0072 refund summary remains for Batch 3/5 forward repair.

## Batch 1 — pre-OTP access and merchant binding (BUG-001/002/017)

### Local status before
Confirmed. Original-source regression fails for pending authentication, shared-email tenant binding and suspended credentials.
### Local root cause
live_sessions omits authenticated filtering; login does a second global email lookup;
session/key lookups ignore merchant suspension.
### References inspected
- [thrzkr/main, 5c3fa2df2202b15d72bd975f3afa1491a4586e26](https://github.com/thrzkr/fils-pay/commit/5c3fa2df2202b15d72bd975f3afa1491a4586e26): OTP predicate and exact login identity.
- [sama-elsawaf/main, 0683d4dc4fbeac59eed03d09ae9d1dad648d79af](https://github.com/sama-elsawaf/fils-pay/commit/0683d4dc4fbeac59eed03d09ae9d1dad648d79af): active merchant payment eligibility.
### Implementation adopted
Session lookup requires authenticated and active merchant; API keys require active merchant;
OTP/session/notifier use the exact user whose password passed; authorize checks active status too.
### Local files changed
apps/api/src/auth/sessions.ts; apiKeys/verify.ts; routes/auth.ts; payments/authorize.ts.
### Regression test
auth/forkBatch1.new.test.ts: pre-OTP denial, shared email, suspended sessions and keys.
### Commands run / result
Original HEAD source extracted to ignored baseline directory, new test copied in:
11/11 regressions fail (`fork-batch1-before.txt`). Current implementation: 11/11 pass (`fork-batch1-focused.txt`).
Auth/app/admin/transactions relevant suite: 114/114 pass (`fork-batch1-subsystem.txt`).
### Differences from reference
Active merchant enforcement at credential resolution also invalidates existing credentials immediately.
### Remaining risk
Suspension changes concurrent with an already-authorized request are not cancelled retroactively.

## Batch 1 — session fixation and browser cookie TTL (BUG-016)

### Local status before
Confirmed in both merchant/admin promotion paths. Merchant cookie kept pending TTL.
### Local root cause
Promotion only updated authentication flag and expiry while keeping token_hash.
### References inspected
- [sama-elsawaf/main, 980278cdd396372d4ea3bb7c49f35efe14998fb4](https://github.com/sama-elsawaf/fils-pay/commit/980278cdd396372d4ea3bb7c49f35efe14998fb4).
### Implementation adopted
Generate new crypto token at promotion; store hash; return new cookie with full TTL.
Promotion rejects revoked/expired/already-promoted sessions. Test login helpers now use verified cookie.
### Local files changed
auth/sessions.ts; adminAuth/sessions.ts; routes/auth.ts; routes/adminAuth.ts;
app.test.ts; routes/admin{,AdjustmentImport,BalanceAdjustments,Credits}.test.ts.
### Regression test / result
Both planes: pending token rejected, OTP succeeds, cookie changes, old token denied, new token works, full TTL checked.
Same commands/results as preceding entry. No assertions removed or weakened.
### Differences from reference
Conditional promotion checks session liveness and checks rowCount.
### Remaining risk
Existing authenticated sessions rotate on next login, not automatically on deployment.

## Batch 1 — secure randomness (BUG-029)

### Local status before
Confirmed: Math.random drives OTP and payment-link token generation.
### Local root cause
Security-sensitive helpers call noncryptographic PRNG.
### References inspected
The focused auth references and local issue were inspected; the report's thrzkr 5c3fa2d contains no random-helper hunk.
### Implementation adopted
Use node:crypto.randomInt independently per character; uniform decimal/alphabet sampling without modulo bias.
Existing payment-link generator inherits secure 132-bit token entropy without format change.
### Local files changed
apps/api/src/lib/random.ts.
### Regression test / result
Math.random replaced with throwing stub: OTP and token helpers succeed and match required alphabet/length.
Fails original source, passes current source (same artifact commands above).
### Differences from reference
No token-format change and no money-package change.
### Remaining risk
No claim of statistical entropy testing; crypto primitive supplies randomness.

## Batch 1 — password/OTP limits and resend races (BUG-015)

### Local status before
Confirmed: unlimited logins; both OTP counters check then increment; resend resets budget and races.
### Local root cause
No persistent login admission budget; non-atomic challenge updates; resend reads outside transaction.
### References inspected
- [sama-elsawaf/main, cb17048a8895681d5e28d3d5222e5f38039d998a](https://github.com/sama-elsawaf/fils-pay/commit/cb17048a8895681d5e28d3d5222e5f38039d998a).
- [follow-up c54488bf46d14d16bf4e9a9f54e4db0cffaba8e6](https://github.com/sama-elsawaf/fils-pay/commit/c54488bf46d14d16bf4e9a9f54e4db0cffaba8e6).
- 980278c parent OTP reservation/consumption implementation.
### Implementation adopted
Persistent counters scoped to account+IP and IP, PostgreSQL advisory lock around admission,
refused requests do not create failures, correct passwords clear reservation, 429 Retry-After.
Shared per-user challenge budget across login/resend; atomic attempt reservation and consumption;
resend locks session before reading/locking its current challenge and preserves attempts.
### Local files changed
auth/loginLimits.ts; config.ts; routes/auth.ts; routes/adminAuth.ts; db/migrations/0073_login_limits.sql.
### Regression test / result
Concurrent guesses stop at five on both planes; login limits do not lock owner at another IP;
rejected attempts leave count unchanged; parallel resends yield one success and one 429 with attempt budget preserved.
11 focused / 114 subsystem pass; typecheck passes.
### Differences from reference
Renumbered migration 0082 to 0073 for our chain. Serializing admission before count/insert closes
the reference's insert/count/delete concurrency gap. Resend takes two statements after session lock
to avoid a READ COMMITTED joined-query snapshot retaining the old challenge after waiting.
### Remaining risk
IP budgets assume unspoofable request.ip (Fastify's default proxy trust remains disabled).
Temporary failure reservations conservatively count in-flight password checks.

## Batch 1 — capture/void roles and impersonation (BUG-004)

### Local status before
Confirmed: capture/void accept support; finance/super-admin impersonation maps to write-capable merchant roles.
### Local root cause
Routes lack role gates; impersonation role mapping grants authority; writer attribution treats grant as merchant session.
### References inspected
sama-elsawaf/main 0683d4d (link above), plus local impersonation and requireMerchantRole call sites.
### Implementation adopted
Capture/void require owner/finance or owner-issued API key; grants always map to support;
role gates and writer attribution explicitly reject impersonation; disabled admins cannot resolve grants.
### Local files changed
routes/transactions.ts; auth/requireMerchantAuth.ts; admin/impersonation.ts.
### Regression test / result
New support capture/void tests fail original source, pass current.
Existing impersonation read/write boundary tests pass in 114-test subsystem run.
### Differences from reference
Also deny grants centrally at role/write attribution boundaries; preserve existing forbidden error contract.
### Remaining risk
Any future merchant write route must continue using role/writer gates.

## Batch 1 — browser API connectivity and root routing

### Local status before
Confirmed by source: clients default to :3000; no API CORS and no Vite proxy; no merchant root route.
### References inspected
- [ali-afk/main, 33f0201b382689b10f51207bb54a8c7be5ba53b9](https://github.com/ali-afk/fils-pay/commit/33f0201b382689b10f51207bb54a8c7be5ba53b9): inspected CORS alternative and root route.
- [sama-elsawaf/main, b018b0a41edf819c48922f70881ad9b7aad02de8](https://github.com/sama-elsawaf/fils-pay/commit/b018b0a41edf819c48922f70881ad9b7aad02de8): chosen same-origin proxy.
### Implementation adopted
Relative client URL defaults in both frontends, Vite /v1 proxy, root Navigate to guarded dashboard.
### Local files changed
apps/{web,admin}/vite.config.ts; apps/{web,admin}/src/api/client.ts; apps/web/src/router.tsx.
### Regression / commands / result
`npm run build --workspace=@filspay/web` and admin: pass.
Live loopback API + both Vite servers: root HTTP 200 and proxied auth JSON 401 on both ports.
`node Evidence/fork-browser-runtime.mjs`; `fork-batch1-runtime.json`.
### Differences from reference
Relative default applies without env files; same-origin production reverse proxy must route /v1 to API.
Explicit API URL overrides remain supported but require deployment's own origin policy.
### Remaining risk
Browser skill setup/discovery returned no browser (`[]`); rendered routing/login could not be verified.
HTTP proof does not establish visual/browser behavior. No CORS added.

## BATCH 1 RESULT

Issues investigated: all seven Batch 1 candidates, plus related tenant binding/suspension/resend/impersonation defects.
Issues reproduced: 11 regression scenarios fail original source; browser defects confirmed in source.
Issues already fixed: none of the candidate defects.
Issues not reproducible: none claimed.
Fixes applied: OTP/auth identity; token rotation/TTL; crypto randomness; persistent limits;
atomic OTP/resend; role/state/grant checks; same-origin proxy and root route.
Reference repositories inspected: sama-elsawaf/main 980278c, cb17048, c54488b, 0683d4d, b018b0a; thrzkr/main 5c3fa2d; ali-afk/main 33f0201.
Files changed: listed per entry above.
Migrations added: 0073_login_limits.sql (applies successfully).
Regression tests added: auth/forkBatch1.new.test.ts, 11 scenarios.
Commands run: original-source regression, focused test, relevant 114-test suite, npm test, npm run typecheck,
both Vite builds, live HTTP probe. Logs linked/named above.
Focused test result: 11/11 pass.
Full TS result: typecheck passes. Broad test attempt: API 360/373 initially; reporting 7/11; events 4/4; money 40/40; web 8/8.
Go result: baseline passes; no Go changes in Batch 1.
Docker/runtime result: live HTTP proxy passes; Docker and browser unavailable.
Evidence updated: this file; fork_mining_baseline.md; fork-batch1-*.txt/json.
Known failures: broad run has 11 refund null-reason failures (Batch 3), one webhook backoff test (Batch 4),
four reporting poison-event failures (Batch 6). Its one impersonation error-code mismatch was resolved;
all relevant 114 tests pass afterward. Baseline source regression confirms actual auth defects independently.
Recommended next batch: Batch 2 payment links.
