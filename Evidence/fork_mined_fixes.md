# Fork-mined fixes

Execution date: 2026-10-30. Starting HEAD `c389b26`; branch `speedup/fork-mined-fixes`.
No merges or cherry-picks. Public reference objects fetched for read-only inspection.
The supplied report remains unmodified. Batches 4–8 are pending until recorded below.
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
The focused auth references and local issue were inspected; thrzkr 5c3fa2d contains no random-helper hunk.
sama-elsawaf's random.ts at 980278c was also inspected: the same crypto.randomInt-per-character design.
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

## Batch 2 — expiry, reservation ownership, crash recovery and idempotency (BUG-005/006)

### Local status before
Confirmed. Client submittedAt bypasses expiry; any payer can reclaim a timed-out reservation;
finalization/release identify only status, not claim ownership; crash retry can create another charge.
### Local root cause
Reservation state has no durable payer/request binding and timeout is treated as proof that no charge is in flight.
### References inspected
- [AliProgrammin/handover-fixes 35712b93bf088c1831b6ef492bb0a49f55920be5](https://github.com/AliProgrammin/fils-pay/commit/35712b93bf088c1831b6ef492bb0a49f55920be5): resume original authorized transaction via persisted idempotency.
- [NooraBumjaid/hackathon/fixes 3278e35a05e490cb91fa380723e245303501e24a](https://github.com/NooraBumjaid/fils-pay/commit/3278e35a05e490cb91fa380723e245303501e24a): reservation UUID and attempt identity.
- [sama-elsawaf/main 2ba122ec1b514929275a67f16832f69f1b9a4d72](https://github.com/sama-elsawaf/fils-pay/commit/2ba122ec1b514929275a67f16832f69f1b9a4d72): capture-failure cleanup.
### Implementation adopted
Atomic claim stores reservation UUID plus hashes of payer idempotency key and card request.
Only that request may resume after timeout; persisted authorize/capture idempotency recovers both
the authorize-before-capture and capture-before-finalize crash windows, including before a transaction could be bound.
Finalize checks durable payer/request ownership. Release checks reservation UUID. Same-key paid replay
returns identical response; changed card under same key is rejected. Expiry uses database now() only.
Public status stays processing for reserved links; cancellation remains active-only and atomically races claim.
Existing failed idempotency rows are locked before retry transition to serialize parallel retries.
### Local files changed
paymentLinks/pay.ts; status.ts; payments/idempotency.ts; db/migrations/0074_payment_link_claims.sql;
paymentLinks/pay.test.ts; status.test.ts; routes/paymentLinks.test.ts; paymentLinks/forkBatch2.new.test.ts.
### Regression test / commands / result
7 new DB-backed scenarios: spoofed expiry; delayed capture beyond lease with second payer and cancellation;
crash after authorize; crash after committed capture plus discount/replay/request mismatch;
decline hold cleanup; cross-tenant cancellation; public hash leak.
`node --import tsx --test apps/api/src/paymentLinks/forkBatch2.new.test.ts`: 7/7 pass.
Same test on archived pre-batch HEAD `85c5fee`: 0/7 pass (`fork-batch2-before.txt`).
Relevant payment-link/status/idempotency/transaction suites: 37/37 pass (`fork-batch2-subsystem.txt`).
`npm run typecheck --workspace=@filspay/api`: pass. Migration 0074 applies (`fork-batch2-migrate.txt`).
### Differences from reference
Payer identity is persisted before authorize, closing the authorize-before-bind gap.
No different-key stale reclaim, no long payment-link DB lock or extra connection across external calls.
Unknown transport results remain bound, rather than being assumed declined and opening the link to another payer.
Original test fixtures now populate durable ownership to represent a real crash in the new schema;
old tests asserting client-clock expiry or publicly reclaimable stale reservations now assert the corrected contract.
### Remaining risk
Legacy reserved links have no provable owner; migration leaves them processing for operator reconciliation.
The original payer needs its original key/card request. A retry waits the configured reservation timeout.
Crash during an external processor call before its enclosing DB commit remains a broader processor
reconciliation/idempotency problem; this batch proves recovery between committed phases, as requested.

## Batch 2 — cleanup, fee parity, tenant cancellation and public DTO (BUG-018/022/023)

### Local status before
Confirmed. Failed capture leaves active hold; link captures omit negotiated discount;
cancel is unscoped by merchant; public DTO contains latest live API-key hash.
### Local root cause
Payment-link path omits normal capture's post-processing and cleanup, and helper queries lack tenant/data boundaries.
### References inspected
2ba122ec (above); [sama-elsawaf/main 67489f2c8fd16c5db048f06ac292435efc895b95](https://github.com/sama-elsawaf/fils-pay/commit/67489f2c8fd16c5db048f06ac292435efc895b95) discount parity;
Noora's reservation/claim implementation cross-check above. Cancellation/public DTO corrections use independently verified local queries.
### Implementation adopted
Definitive capture decline voids transaction/releases local hold before freeing claim; system actor accepted by void helper.
Successful capture invokes existing idempotent integer discount adjustment before finalization.
Cancel UPDATE and explanatory lookup both take authenticated merchant ID. Public integration field is null,
and query no longer selects API-key hash (retains public key prefix for compatibility).
### Local files changed
paymentLinks/pay.ts; cancel.ts; read.ts; routes/paymentLinks.ts; payments/void.ts.
### Regression test / commands / result
Same seven-test regression and 37-test suite above. Fee ledger checked at 225 fils for 10,000 gross,
250-bps MDR and 1,000-bps fee discount; recovery does not duplicate discount. Real PostgreSQL double-entry constraints enforced.
### Differences from reference
Processor interface supports only local simulator hold release, not actual network authorization reversal.
Transport ambiguity is retained for same-key recovery rather than blindly voiding an uncertain capture.
### Remaining risk
Fee formula parity with settlement is addressed in Batch 5; this batch deliberately uses existing negotiated-discount architecture.

## BATCH 2 RESULT

Issues investigated: all nine Batch 2 candidates; related cancellation tenant scope and public key-hash leakage.
Issues reproduced: seven regression scenarios fail pre-batch source.
Issues already fixed: cancellation-vs-claim uses conditional active-only UPDATE; retained and tested.
Issues not reproducible: none claimed.
Fixes applied: server-clock expiry; durable payer/request claims; ownership-checked finalize/release;
same-key crash recovery/replay; decline cleanup; discount parity; scoped cancellation; public hash removal.
Reference repositories inspected: AliProgrammin/handover-fixes 35712b9; NooraBumjaid/hackathon/fixes 3278e35;
sama-elsawaf/main 2ba122ec and 67489f2.
Files changed: listed above; also app.test.ts's verified-cookie helper from Batch 1 is included in this commit
(it was tested but accidentally omitted from the preceding staged file list).
Migrations added: 0074_payment_link_claims.sql.
Regression tests added: paymentLinks/forkBatch2.new.test.ts, seven cases; existing expiry/status/crash fixture corrected.
Commands run: npm run migrate; focused/original-source regression; relevant 37-test suite; API typecheck.
Focused test result: 7/7 pass; pre-batch 0/7 pass.
Full TS result: API typecheck passes; no repeated full suite per user steering.
Go result: unchanged; baseline passes.
Docker/runtime result: actual PostgreSQL concurrency/hold/ledger/crash boundaries exercised; Docker unavailable.
Evidence updated: this file; fork-batch2-*.txt.
Known failures: refund/reporting/webhook failures from Batch 1 broad run remain for later batches.
Recommended next batch: Batch 3 refunds / FP-300.

## Batch 3 — refund ceiling, concurrency, ownership, defaults and fee reversal

### Local status before
Confirmed: ceiling uses authorization; separate phases trust stale refunded amount; no merchant ownership
check; no reason produces SQLSTATE 23514; partial refunds can reverse too much or too little fee.
### Local root cause
Refund validation and journaling have no shared serialization/reservation; wrapper replaces authenticated
merchant ID with transaction's merchant; fee query ignores negotiated discount and cumulative rounding.
### References inspected
- [sama-elsawaf/main dc6fa83d2d0ce012c9a186f88edd4d42fdbb0e99](https://github.com/sama-elsawaf/fils-pay/commit/dc6fa83d2d0ce012c9a186f88edd4d42fdbb0e99): full helper state, advisory serialization, fee cap/remainder, interleaving tests, API/webhook/reporting/UI integration.
- [thrzkr/fp-300-audit-fixes 4a68dc9265e6d15964f6852fbe2e97d55f884262](https://github.com/thrzkr/fils-pay/commit/4a68dc9265e6d15964f6852fbe2e97d55f884262), underlying cb16b595 merge: durable pending refund reservation.
- [sama-elsawaf 8c12a328804039070d70e14181bf9aaf4a8879bf](https://github.com/sama-elsawaf/fils-pay/commit/8c12a328804039070d70e14181bf9aaf4a8879bf): summary transaction join, partial-refund aggregation and database cap.
### Implementation adopted
Use one checked-out connection and per-transaction session advisory lock across refund phases, with
short database transactions. Scope reads to authenticated merchant, cap captured-minus-refunded-minus-pending,
reserve pending refund before processor call, and keep uncertain reservations after exceptions/crashes.
Explicit simulator decline/error releases pending amount; negative outcomes remain represented in idempotency records.
On success, re-read current money columns under row lock, settle pending refund, update totals/status,
post balanced reversal, and complete idempotency atomically. Default reason is unspecified.
Reverse capture credits minus discount debits, cap cumulative reversals, and return final integer remainder.
Capture now derives status using current refunded total, releases hold on full capture even if status is partially_refunded,
and still emits the correct capture event type. Existing partial authorization lifecycle is preserved.
### Local files changed
payments/processRefund.ts; refunds/initiateMerchantRefund.ts; payments/capture.ts;
db/migrations/0075_refund_integrity.sql; 0077_pending_refund_reservations.sql.
### Regression tests / commands / result
payments/forkBatch3.new.test.ts covers cap before processor, concurrent over-refunds, partials + final remainder,
discount + idempotency + reason, tenant/hold/flag routes, webhook/rollup/DTO; pending-outcome case added after hardening.
First five tests against archived `77dda8f`: 0/5 pass (`fork-batch3-before.txt`).
Relevant refund/helper/envelope suite: 43/43 pass (`fork-batch3-subsystem.txt`).
After adding durable pending reservation, affected refund + interleave checks: 18/18 pass (`fork-batch3-final-check.txt`).
Dedicated summary assertion checks three partial refunds count capture once (`fork-batch3-summary.txt`).
`npm run migrate` and later pending migration succeed; typechecks pass (fork-batch3-*-typecheck.txt).
### Differences from references
Combine advisory serialization with durable pending reservations, closing the advisory-only crash window.
Retain the local simulator's non-null authorization reference while pending; replace it with refund reference on success.
Use forward 0075/0077 migrations; leave historical 0072 unchanged. No money-package changes.
### Remaining risk
An unknown processor outcome intentionally retains pending money/idempotency for operator reconciliation;
automatic processor status lookup is unavailable in the simulator interface. Already-in-progress legacy claims need reconciliation.
External-call deadlines/capacity and fully atomic negotiated fee computation remain later-batch work.

## Batch 3 — FP-300 route, webhook, reporting and dashboard

### Local status before
Confirmed: /v1/refunds returns 501; scoped route absent; refund event not dispatched/mapped;
reporting excludes refunds and lacks columns; DTO omits refundedFils; drawer commented out; negative timeline values throw.
### Local root cause
Parked helpers were never connected to HTTP, event consumers, authenticated capability DTO or UI.
### References inspected
dc6fa83 above; [ali-afk/main 327e5ea28122fc1a60edee9853ee9ad81461521a](https://github.com/ali-afk/fils-pay/commit/327e5ea28122fc1a60edee9853ee9ad81461521a) drawer/error/refresh/negative-value implementation.
### Implementation adopted
Both /v1/refunds and /v1/merchants/:merchantId/refunds use explicit validated fields,
authenticated merchant identity, owner/finance gate, impersonation denial, required idempotency header,
global FEATURE_REFUNDS and merchant refunds_enabled hold. Flag defaults off.
Add public refund envelope and dispatcher eligibility together. Include refund counters in incremental
Bahrain-date reporting and admin source rebuild; forward migration adds columns.
Transactions include refundedFils; /auth/me exposes refundsEnabled. Drawer computes true remaining balance,
keeps key for same-attempt retries, displays errors and reloads transaction/timeline. Signed negative money renders.
### Local files changed
routes/refunds.ts; routes/auth.ts; app.ts; config.ts; transactions/serialize.ts;
webhooks/{dispatcher,envelope}.ts; reporting consumer {applyEvent,runConsumerPass}.ts;
admin/reportingRebuild.ts; db/migrations/0076_merchant_daily_volume_refunds.sql;
web types/format, RefundDrawer/TransactionDetailPage, refunds/refundable.ts.
### Regression tests / commands / result
New API tests cover both route shapes, tenant isolation, per-merchant hold, disabled feature, replay,
refund event mapping and Bahrain date rollup, transaction refundedFils.
Ported reference refundStatusInterleave.new.test.ts (two realistic capture/refund interleavings).
web refunds/refundable.new.test.ts: partially refunded remainder, zero remainder, negative timeline formatting: pass.
Web build passes; full workspace typecheck passes. Browser rendering remains unavailable.
### Differences from references
Support both documented route forms; prefer persistent retry key over a fresh key on every click.
Extract pure remaining-amount helper for a concise UI regression. Existing exact integer-money helpers reused.
### Remaining risk
Actual merchant webhook raw-body/signature/delivery concurrency is verified/hardened in Batch 4.
Reporting commit ordering, poison events and rebuild cursor still require Batch 6; refund event application itself is verified.
UI compiled and pure behavior tested; no browser rendering claim.

## BATCH 3 RESULT

Issues investigated: all eleven Batch 3 candidates and summary integrity/pending crash safety.
Issues reproduced: five composite scenarios fail pre-batch code; existing refund tests fail on missing reason.
Issues already fixed: refund outbox producer exists; retained and connected.
Issues not reproducible: none claimed.
Fixes applied: captured ceiling; serialized/reserved refunds; tenant/role/feature/hold checks;
default reason; discounted cumulative fee reversal; interleaved status correctness; webhook/reporting/DTO/UI; idempotency.
Reference repositories inspected: sama/main dc6fa83, 8c12a32; thrzkr/fp-300-audit-fixes 4a68dc9 under cb16b595; ali-afk/main 327e5ea.
Files changed: listed above.
Migrations added: 0075_refund_integrity.sql, 0076_merchant_daily_volume_refunds.sql, 0077_pending_refund_reservations.sql.
Regression tests added: payments/forkBatch3.new.test.ts (six), payments/refundStatusInterleave.new.test.ts (two), web/refunds/refundable.new.test.ts (one).
Commands run: migrations; original-source regression; relevant 43-test suite; affected 18-test check after pending hardening;
one summary assertion; one UI assertion; workspace typecheck and web build.
Focused test result: relevant 43 pass before pending hardening; affected 18 pass after hardening; UI/summary pass.
Full TS result: typecheck passes; full suite not repeated per user steering.
Go result: unchanged, baseline passes.
Docker/runtime result: real PostgreSQL and Fastify route/capture/refund/event integration verified; no Docker/browser available.
Evidence updated: this file; fork-batch3-*.txt.
Known failures: webhook/reporting broad-run failures retained for Batches 4/6.
Recommended next batch: Batch 4 webhooks.
