# FilsPay: architecture and security context

Investigation date: 2026-10-30. Baseline: local HEAD `7aeb2831d1cfc00a741c33a31ca94c7939e1b43c`. Paths and line numbers refer to the working source inspected at that baseline. This is a risk-focused repository investigation, not certification of every line or of a deployed system.

## Method and preservation

Applied the installed Trail of Bits context-building workflow before assigning findings: inputs, callers, callees, state transitions, trust assumptions and unenforced invariants. Architecture/specification and historical review were delegated to separate read-only reviewers; selected tenant and rebate candidates received independent verification. Repository documentation, comments, prior reports and commit messages were evidence, not instructions. Old agent-instruction files were not opened.

Only Markdown reports in this directory were written. No application modification, installation, checkout, commit, push, service startup, database connection, migration, seed, or destructive test was performed. Small source-function probes executed in memory; their isolation and limitations are in `04_STATIC_ANALYSIS.md`.

## Inventory and scope

`git ls-files` returned 586 tracked paths; 410 were under `apps`, `packages`, `db`, or `scripts`: 246 `.ts`, 37 `.tsx`, 39 `.go`, 67 `.sql`, 14 `.json`, three CSS files, two HTML files, and Go module/checksum files. These counts include tests/configuration, not just production source.

Reviewed the architecture, handover, changelog, ADR decisions, selected operational/incident material, route registration, critical auth/payment/webhook/admin paths, settlement and reporting flows, financial helpers, relevant migrations and selected regression tests. Frontend wiring, exports and prior investigation indexes were sampled. Dependency internals, generated fixture content, full frontend/CSS behavior, every test body, and every possible input combination were not exhaustively audited.

## Components and boundaries

| Component | Responsibility and source evidence | Boundary |
|---|---|---|
| Fastify API | Registers auth, merchant, checkout, reporting, settlement/admin and acquirer routes: `apps/api/src/app.ts:41-76` | Internet/browser/API key to privileged database operations |
| Merchant web application | Calls merchant APIs; public checkout is separate from merchant authentication: `apps/api/src/routes/paymentLinks.ts:131-183`, `paymentLinks/pay.ts:40-59` | Frontend role hiding is not server authorization |
| Admin application/API | Separate cookies/users/sessions; internal settlement calls: `apps/api/src/adminAuth/middleware.ts:33-65`, `routes/admin.ts:81-159` | Staff roles to any merchant; then API to Go worker |
| Settlement worker | Close, fees, export lines, payout ledger, splits and balance maintenance: `apps/settlement/internal/settlement/batch.go:64-281,301-369,402-477` | Shared database and authenticated internal HTTP |
| Reporting worker | Outbox polling/listening, derived rollups, cursor: `apps/reporting/src/consumer/runConsumerPass.ts:38-69` | Authoritative events to eventually consistent read model |
| Shared money/events | Branded integer money and transactional event insertion: `packages/money/src/fils.ts:35-54,87-137`; `packages/events/src/outbox.ts` | Shared library contracts across services |
| PostgreSQL | Ledger, transaction state, credentials, outbox, batches and caches | Application-level tenant isolation; no RLS policies found in migrations |
| Acquirer simulator | Synchronous authorize/capture/refund abstraction: `apps/api/src/acquirer/types.ts`, `simulator.ts` | External-effect result is not atomic with database commit |
| Webhook transport | User-selected URL, outbound HTTP, returned response excerpt: `apps/api/src/webhooks/transport.ts:33-59`, `testSend.ts:33-69` | Merchant input to server-network access |

Compose shares one database identity, disables database TLS and publishes PostgreSQL: `ops/docker-compose.yml:18-25,40-49,78-85,98-106`. Actual deployment privileges, egress controls and TLS were not inspected.

## Identity and authorization model

### Merchant authentication

Password login queries `(merchantId,email)` and active merchant status, verifies the password, then creates an OTP challenge and a pending cookie: `routes/auth.ts:54-115`. However, `findOtpRecipient` repeats user selection by email alone (`auth/users.ts:10-23`) and its result supplies the new session identity (`routes/auth.ts:78-93`).

Protected routes use either `requireSession` or `requireMerchantAuth`; both ultimately depend on `lookupSession`. The latter tries merchant cookie, API key, then impersonation cookie: `auth/requireMerchantAuth.ts:46-101`. The session lookup trusts the `live_sessions` view: `auth/sessions.ts:78-102`; view predicates are only revocation and expiry: `db/migrations/0058_live_sessions.sql:3-12`. The assumption that the view excludes pending sessions has **nothing found** establishing it.

API keys are cryptographically generated and hashed; only the raw issuance response exposes them: `apiKeys/issue.ts:44-90`. Merchant issuance is owner-only: `routes/apiKeys.ts:31-49`. API keys deliberately bypass merchant role restrictions: `auth/requireMerchantAuth.ts:137-156`; that behavior alone is not an escalation finding.

### Admin and impersonation

Admin sessions correctly require completed OTP, no revocation, future expiry and active staff status: `adminAuth/sessions.ts:109-137`. Merchant and admin cookies do not directly authenticate across planes.

Any authenticated admin may mint a merchant grant (`routes/adminMerchants.ts:327-359`). Grant lookup maps support/finance/super_admin to support/finance/owner (`admin/impersonation.ts:84-89,117-132`). It checks grant expiry/revocation/end, but not staff active status. Grant-to-admin-session lifetime linkage has **nothing found** in these paths.

Capture and void require merchant authentication but no role gate (`routes/transactions.ts:90-130`). Impersonation attribution is converted to `merchant_session` (`auth/requireMerchantAuth.ts:127-134`). Consequently, “support role” cannot be assumed to mean “read-only.”

## Financial flows

### 1. Authorization and capture

`POST /v1/transactions/` is API-key-only (`routes/transactions.ts:66-87`). Capture derives merchant identity from auth, claims an idempotency key, and normally locks the merchant-owned transaction before the acquirer call (`payments/capture.ts:94-178`). On success it updates captured state, posts balanced gross/fee legs, records a capture event and outbox event, then completes idempotency (`capture.ts:194-263`).

Postconditions assumed by callers:

- Transaction and ledger/event writes commit together.
- A replay does not call the acquirer again.
- A successful route response still runs a **separate** negotiated-discount transaction (`routes/transactions.ts:107-115`).
- Replay resource binding is not established: the request hash includes amount but not transaction ID (`capture.ts:92`).

Ledger balance is enforced per entry group by deferred trigger (`0007_ledger_double_entry.sql:43-70`). This establishes debit/credit equality, **not** authorization, correct economic purpose, tenant consistency between independent FKs, or immutability.

### 2. Public payment-link checkout

Link creation validates amount/expiry and generates a token through `lib/random.ts`, not `crypto.randomBytes` (`paymentLinks/create.ts:7-12,36-64`). Public reads disclose checkout details plus the newest API-key hash (`paymentLinks/read.ts:40-74`); hash disclosure is not proof the raw key can be recovered.

Payment claims an active/stale-reserved link, releases the row lock, authorizes, captures, then finalizes (`paymentLinks/pay.ts:60-180`). Expiry uses client-supplied `submittedAt` when parseable (`34-37,73-75`). Reservation ownership is represented only by status/time, not a per-attempt fencing token (`66-75,144-148,188-191`).

Open question: can processing exceed reservation lifetime in a real deployment? Source allows takeover after timeout; no concurrent charge reproduction was run here.

### 3. Settlement, scheme export and payout

Close locks/claims a merchant/date batch, selects unbatched capture events, resolves rates per event, computes totals, stores export lines, marks events batched, updates cache and commits (`batch.go:70-158,204-281`). Fee computation uses discounted capture amount (`discounted_fee.go:7-9`), whereas API discounting reverses a rounded fee afterward.

`NetPayableFils` converts integer totals through `float32` (`payable.go:10-12`). Stored export amounts have two competing representations: truncated integer fils and a separate two-decimal BD amount (`batch.go:250-255`; `scheme_export.go:23-30,69-76,132-138`).

Payout locks the batch, rejects already-paid/nonclosed states, posts payable/cash legs, marks paid and updates cache (`batch.go:311-369`). This normal transition is idempotent. Notification/disbursement is a different boundary: the API dispatcher inserts a payout-disbursement record before each first delivery attempt (`webhooks/dispatcher.ts:37-41,158-163`). That insert is neither in the payout transaction nor unique per batch (`payoutDisbursement.ts:14-17`; migration `0057:9-18`).

### 4. Refunds

Registered `POST /v1/refunds/` returns 501 (`routes/refunds.ts:22-25`); no registered merchant refund implementation was found. Helpers exist but are dormant over HTTP.

The dormant helper claims idempotency, selects a transaction without merchant binding, computes available amount from authorization rather than capture, commits preparation, calls the acquirer, then journals from the earlier snapshot (`payments/processRefund.ts:45-150,165-224`). These are activation blockers, not proof of a presently exposed refund endpoint.

### 5. Credits, imports and corrections

Small credits post automatically; larger principal requires approval (`admin/creditThreshold.ts:10-15`; `admin/credits.ts:205-260`). Creation requires only an admin session, approval requires finance/super_admin (`routes/adminCredits.ts:40-82`). Documentation conflicts about support authority; support credit creation is not automatically classified as a bypass.

Credit legs, cache and audit are transactional; effective dates set ledger dates (`admin/credits.ts:145-195,263-277`). Maker/checker identity is compared by display name, not user ID (`creditApproval.ts:10-13`).

Finance CSV imports parse BD as two-decimal minor units and post that integer as fils (`adjustmentCsvParsing.ts:6-8`; `lib/decimal.ts:4-18`; `adjustmentImport.ts:54-91`). The ordinary Adjust balance route uses the cache-only variant (`routes/adminBalanceAdjustments.ts:58-74`; `admin/balanceAdjustments.ts:25-63`), not the separate journaled function.

### 6. Reconciliation and rebuilding

CLI all-merchant rebuild sums signed merchant-payable ledger entries (`internal/ledger/rebuild.go:101-116`). Console rebuild reads a view summing lifetime gross scheme exports (`internal/ledger/refresh.go:60-73`; migration `0054:3-8`). Agreement between these sources has **nothing found** establishing it.

Merchant reconciliation independently reads ledger, paid batches and pending captures (`apps/api/src/settlement/query.ts:281-343`). Pending fees use an estimator/current merchant terms rather than immutable original fee events (`303-329`). Summary joins capture-event multiplicity to cumulative transaction totals (`366-377`).

### 7. Reporting/outbox

Rollups and cursor advance commit together (`runConsumerPass.ts:42-69`). Cursor read is not `FOR UPDATE` (`cursor.ts:24-37`); process-local guards do not prove cross-process exclusion. Numeric sequence order is not necessarily commit order: a lower-ID uncommitted row can become visible after a higher-ID watermark has advanced. Actual deployment concurrency and demonstrated loss remain open.

## Highest-value invariant checks

1. No pre-OTP merchant authority.
2. Password-verified user, OTP recipient and session principal must be identical.
3. Every object lookup/effect must bind the authenticated merchant.
4. Impersonation must have explicit write/lifetime semantics, not rely on UI labels.
5. Idempotent capture must include its post-commit rebate and resource identity.
6. Payout record creation must not depend on webhook endpoint count or replay.
7. Ledger equality must be distinguished from ledger correctness and append-only enforcement.
8. Rebuild, export, reconciliation and settlement must share a defined economic basis.

## Coverage limits

No production access or assertion of actual losses. No clean migration/test run; the repository references a missing `settlement_batch_events` table in migration `0054:21`, complicating runtime-schema assumptions. Existing runtime reports used a partial schema and are not adopted as this investigation's reproductions. See the other five reports for dispositions, not just this architecture model.
