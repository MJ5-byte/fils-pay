# FilsPay audit — confirmed bugs in the current checkout

**Audit date:** 2026-10-30  
**Scope:** the whole repository at `HEAD` (`10b4c35`), with particular attention to
the case-file list (B1–B24, F1–F5), `docs/ENGINEERING.md`, `docs/EXPLANATIONS.md`
and the incident/runbook material.  
**Rule used:** a finding is listed only where the current code actually does the
wrong thing (or the feature the code claims to provide is absent). Things that
are demonstrably fixed, dead code with no callers, or explicitly accepted by
`AGENTS.md` are in the “verified working / do not report” section at the end.

**Confirmed findings:** 59 numbered findings: 6 critical money, 13
auth/security, 4 payment-link, 12 money-path/reporting, 7 reliability,
9 input/hardening, and 8 lower-severity. The case-file map below also records
which case items are already fixed and must not be reported again.

Severity is from the point of view of the platform: **Critical** = money can be
lost, created, or paid twice; **High** = a security boundary or a core money
feature is broken; **Medium** = incorrect reporting/operational behaviour or a
reliability hole; **Low** = edge cases, hardening, or documented limitations.

---

## 0. Case-file map (read this before the findings)

This is the quick answer to “was bug Bx actually fixed?”. “Still” means the
current checkout still contains the problem; “partial” means the headline fix
landed but a second path or edge case is still broken; “fixed” means the code is
now correct and must **not** be reported as a bug.

| Case item | Status in this checkout | Notes |
|---|---|---|
| B1 — CSV import 10x off | **Fixed** | `parseAdjustmentAmountFils` now delegates to `parseBhdToFils` (`apps/api/src/admin/adjustmentCsvParsing.ts:7`). |
| B2 — split payouts a few fils short | **Still / partial** | The Go split allocator is fixed, but `NetPayableFils` still computes in `float32` (`apps/settlement/internal/settlement/payable.go:10-12`) and therefore still loses fils on large batches. Child shares are exact only for the already-rounded parent net. |
| B3 — scheme statement a few fils high / residue not posted | **Fixed** | `CloseBatch` now derives `amount` from the truncated integer and posts the residue group (`apps/settlement/internal/settlement/batch.go:250-280`). |
| B4 — MDR recalc rewrites paid batches | **Fixed for the paid-batch guard** | Query is now `status = 'closed'` (`apps/settlement/internal/settlement/recalculate_mdr.go:70`). A different accuracy problem in the recalculation itself is listed below. |
| B5 — March sweep not idempotent / wrong month | **Fixed** | `monthBounds` is a fixed +03:00 month and `postResidueCorrection` uses a `NOT EXISTS` guard (`scripts/reconcile_march.ts:18-106`). |
| B6 — dashboard shows 245 bps, capture charges 225 | **Fixed** | Display now filters `effective_from <= now()` and orders by `effective_from DESC, created_at DESC` (`apps/api/src/fees/currentFeeScheduleDisplay.ts:30-38`). |
| B7 — cached balance button 135K→7K | **Fixed for the button and full CLI** | Internal handler uses `ledger.RebuildAllBalances`; the old `RefreshBalanceCache` is unused. The `--merchant` CLI path is broken (finding M-6). |
| B8 — refund ceiling used authorized amount | **Fixed** | `refundableFils = captured − refunded` (`apps/api/src/payments/processRefund.ts:97`). |
| B9 / FP-209 — concurrent refunds double money out | **Fixed** | Whole refund is one transaction with `SELECT ... FOR UPDATE` across the acquirer call (`apps/api/src/payments/processRefund.ts:59-68`). |
| B10 — lifetime payout estimate drifts | **Fixed at the live accumulator; latent elsewhere** | `UpdateLifetimePayoutMonitoringEstimate` now uses `int64`; `EstimateMonthlyPayout` still returns `float32` (finding L-1) and the seed still uses `Math.fround` (L-2). |
| B11 / FP-240 — webhook signatures rejected | **Fixed** | Dispatcher serializes once and signs those exact bytes (`apps/api/src/webhooks/dispatcher.ts:155-160`). |
| B12 — login works without OTP | **Partially fixed** | `live_sessions` now filters `authenticated = true` (`db/migrations/0058_live_sessions.sql`), but OTP recipient binding, the attempt race, resend budget and session fixation are still broken (H-7–H-10). |
| B13 — cross-merchant payment-link cancel | **Fixed** | Update carries `merchant_id = $2` (`apps/api/src/paymentLinks/cancel.ts:18-24`). |
| B14 — link payable after expiry | **Partially fixed** | The public route ignores `submittedAt` unless a key is present, but *any* merchant’s API key is accepted, not the link owner’s (H-3). |
| B15 / incident 2026-05-14 — link charged twice | **Partially fixed** | The fake 200 was removed, but the flow is not one transaction, a failed finalize does not void the capture, and a capture failure leaves the authorization/hold alive (P-1). |
| B16 / FP-201 — duplicate callback notes | **Fixed for dedup** | Unique `(transaction_id, callback_id)` and `ON CONFLICT DO NOTHING` (`db/migrations/0073...`, `apps/api/src/acquirer/callbacks.ts:42-52`). Inbound signature freshness/raw-body issues remain (H-12/H-13). |
| B17 — duplicate payout notifications | **Fixed for outbox/disbursement dedup** | 0075/0076 + `ON CONFLICT`; the dispatcher still has no claim/skip-locked mechanism (R-3). |
| B18 — close at 03:15 local | **Fixed** | `BusinessDayWindow` normalizes to `Asia/Bahrain` (`apps/settlement/internal/settlement/window.go:46-60`). |
| B19 — test merchants in real settlement | **Fixed** | `CloseBatch`/`RunDailyBatch` filter `test_mode = false`; seed skips test-mode settlement/outbox (`db/seed/generate.ts:579-591`). |
| B20 — missing admin role gates / impersonation escalation | **Partially fixed** | Credit creation is finance+, and every admin role maps to merchant `support`; the merchant write routes do not honor that read-only promise (H-3, H-4). |
| B21 — webhook encryption-key rotation kills delivery | **Still open** | No key-id/version, no previous-key window, no re-encrypt path (`apps/api/src/webhooks/secretCrypto.ts`; R-4). |
| B22 — slow reporting query | **Fixed** | `getRecentLedgerActivity` uses bare indexed `occurred_at` bounds (`apps/api/src/analytics/query.ts:300-315`). |
| B23 — large export / streaming twin dead | **Fixed for streaming** | Route uses `streamTransactionsExportCsv` with an `(occurred_at, id)` keyset (`apps/api/src/transactions/exportCsv.ts:55-105`). CSV formula injection remains (S-3). |
| B24 — Dockerfiles missing | **Fixed** | `ops/Dockerfile.node`, `ops/Dockerfile.go`, `env_file`, and the token wiring exist. |
| F1 — refunds were a 501 stub | **Fixed** | `POST /v1/refunds` is wired to `initiateMerchantRefund`. |
| F2 — fee reversal not discount-aware | **Fixed for the refund path** | `processRefund` nets the discount leg and excludes prior refunds (`apps/api/src/payments/processRefund.ts:112-134`). Capture-side discount gaps are separate (C-5, C-6). The old “settlement to do” item for refunds is still absent (C-2). |
| F3 — `refund.succeeded` not shippable | **Fixed** | Envelope case and eligibility entry are both present. |
| F4 — UI surfaces | **Fixed** | Web `RefundDrawer` posts to `/v1/refunds`; admin has no refund surface, which is documented as deliberate. |
| F5 — refund ledger/rows correctness | **Fixed** | Reason defaults to `'unspecified'`; matview join is on `r.transaction_id`. |
| M1 — seed corruption | **Fixed** | Poison dump deleted; alpha fee rate and test-mode settlement fixed. The monitor estimate seed still uses `Math.fround` (L-2). |
| M2 — transmissions / flag | **Not a code bug** | Story/flag only. |

---

## 1. Critical money defects

### C-1. `NetPayableFils` still uses `float32`, so large payouts are a few fils short
**Location:** `apps/settlement/internal/settlement/payable.go:10-12`  
**What is wrong:** The function computes
`float32(grossFils)/1000 - float32(feeFils)/1000`, then converts back with
`math.Round`. This is the exact second mechanism called out in B2. For a gross
of `16,777,200` fils (16,777.200 BD), fee `0`, it returns `16,777,199` fils.
Every amount above `2^24` fils can drift.  
**Why it matters:** `CloseBatch` stores this value in
`settlement_batches.net_payout_fils`, `PayoutBatch` posts it to the ledger, and
the balance cache uses it. The financial statement, bank instruction and ledger
therefore all carry the wrong net. It also contradicts `EXPLANATIONS.md` B2,
which says `NetPayableFils` is now plain integer `gross − fee`.  
**Suggested fix:** `return grossFils - feeFils` (or a checked integer
subtraction). Do not use `float32`/`float64` anywhere in this path.  
**Confidence:** High (reproduced by computation).

### C-2. Refunds are not applied to settlement, payouts, or the reconciliation balance
**Location:** `apps/api/src/payments/processRefund.ts` (inserts into `refunds`,
never sets `settlement_batch_id`); `apps/settlement` has no refund selection;
`apps/api/src/admin/settlementClient.ts:277-296` calls
`/internal/refund-adjustment`, but `apps/settlement/internal/internalapi/server.go`
registers only `/internal/run-batch`, `/internal/rebuild-balances` and
`/internal/recalculate-mdr`.  
**What is wrong:** A successful refund debits `merchant_payable` and credits
`card_scheme_clearing`, updates `transactions.refunded_fils`, and emits a
webhook. Nothing ever reduces a future `settlement_batches.net_payout_fils` or
the payout instruction. `refunds.settlement_batch_id` remains `NULL` and is
never claimed. The helper that claims to notify settlement points at a route
that does not exist, and it is not called from `processRefund`.  
**Why it matters:** The merchant is paid the full captured amount and the refund
is an extra debit in the ledger. Depending on timing, the merchant’s cache goes
negative or they are overpaid by the refund amount. This is exactly the
“adjust the merchant’s next settlement batch” requirement in the FP-212 ticket
and it is why a period containing a refund cannot reconcile.  
**Suggested fix:** Claim unbatched refunds in `CloseBatch` (or a separate
settlement adjustment step), net them out of the next payout with the correct
fee reversal, set `refunds.settlement_batch_id` in the same transaction, and
make the internal refund-adjustment route real or delete the dead client.  
**Confidence:** High (feature is absent; ONBOARDING still says “Settlement: batch
reopen … to do”).

### C-3. `getSettlementSummary` double-counts every multi-capture transaction
**Location:** `apps/api/src/settlement/query.ts:370-393`  
**What is wrong:** The CTE emits one row per capture event but carries
`t.captured_fils` (the transaction’s running total) on every row, then
`SUM(captured_fils)` adds that running total once per capture event. A
transaction captured `60,000` then `40,000` contributes `200,000`, not `100,000`.
`COUNT(DISTINCT id)` hides the duplicate at the transaction count but not in the
money figure.  
**Why it matters:** The settlement summary page overstates gross captured for
multi-capture merchants. The July perf note already observed “summary higher
than batches by 38% for Delta Wholesale” and attributed it to timing; the actual
cause is this fan-out.  
**Suggested fix:** Sum `te.amount_fils` (the per-event delta) in the CTE, not
`t.captured_fils`; or aggregate distinct transactions before summing. Add a
multi-capture regression test (the existing test only has single captures).  
**Confidence:** High.

### C-4. Reconciliation formula subtracts payout settlements without removing the payout debit
**Location:** `apps/api/src/settlement/query.ts:282-353`  
**What is wrong:** `ledgerMerchantPayableNetFils` is the net movement of
`merchant_payable` over the window, which includes the **payout debit** posted
by `PayoutBatch`. `settlementNetPayoutFils` sums `settlement_batches` with
`status IN ('closed','paid')`. For a paid batch in the same window:
ledger = `+net − net = 0`, settlement = `+net`, so
`gap = 0 − net − pending = −net`. The existing route test hides this by posting
the payout outside the query window (`apps/api/src/routes/settlement.test.ts:158-180`).  
**Why it matters:** Any real month/range that includes a paid batch reports a
negative gap, even though the money is fully accounted for. That is a direct
finance/reconciliation failure. Refunds make the gap worse because the ledger
movement is reduced by the refund but `settlementNetPayoutFils` is unchanged.  
**Suggested fix:** Define the comparison terms explicitly: either use the
merchant’s closing balance instead of the period movement, or include the
payout movement on the settlement side; do not count a paid batch twice. Add a
paid-batch-inside-window test and a refund-in-window test.  
**Confidence:** High (formula reproduced from the queries).

### C-5. Capture discounts are not applied on the payment-link path (and are a separate transaction on the direct path)
**Location:** `apps/api/src/routes/transactions.ts:108-115` is the only caller of
`applyCaptureDiscountAdjustment`; `apps/api/src/paymentLinks/pay.ts:127-136`
calls `captureTransaction` directly and never applies it;
`apps/api/src/payments/capture.ts:200` charges the pre-discount MDR.  
**What is wrong:** For a merchant with `negotiated_discount_bps > 0`:
- direct API capture: the fee is journaled inside `captureTransaction`, then the
  rebate leg is posted in a **second transaction after commit**. If the process
  dies or the second transaction fails, the capture is committed without the
  rebate and there is no retry/outbox job;
- payment-link payment: `payPaymentLink` never calls the adjustment at all, so
  the merchant pays full MDR in the ledger while settlement later computes the
  discounted fee.  
**Why it matters:** Delta Marketplace (seed `negotiatedDiscountBps: 1250`) is
exactly this case. The merchant is overcharged on payment-link sales and the
ledger disagrees with settlement. This is a variation of F2 that the refund fix
did not cover.  
**Suggested fix:** Move the discount application into the capture transaction
(or into `captureTransaction` itself, using the same locked client), so both
entry points get one atomic journal and one fee. Never apply a money leg after
the capture commits.  
**Confidence:** High.

### C-6. The discount adjustment uses only the latest capture event on a multi-capture transaction
**Location:** `apps/api/src/payments/discountAdjustment.ts:34-90`  
**What is wrong:** The count guard compares the number of adjustments with the
number of capture events, but the calculation reads only the most recent
capture event (`ORDER BY occurred_at DESC, id DESC LIMIT 1`) and applies one
rebate for that event. On a transaction captured in instalments, earlier
events’ fees are never rebated, and the guard can treat the single rebate as
covering all events.  
**Why it matters:** Multi-capture merchants with a negotiated discount are
under-credited; the seed has an instalment fixture and Delta Marketplace uses
multi-capture style traffic.  
**Suggested fix:** Apply the discount per capture event inside the capture
transaction (same fix as C-5), or aggregate all unrebated capture-event fees and
post one adjustment for the exact sum.  
**Confidence:** High.

---

## 2. Critical / High security and authorization defects

### H-1. Admin API-key rotation does not revoke the old key
**Location:** `apps/api/src/admin/apiKeys.ts:31-46`  
**What is wrong:** `rotateApiKeyAsAdmin` locks the old row, checks it is not
revoked, issues a replacement with `rotated_from_key_id`, writes an audit row,
and returns. It never runs `UPDATE api_keys SET revoked_at = ...` and never
sets `revoked_reason`. The migration comment itself notes that the old key
still authenticates (`db/migrations/0037_api_keys_admin_rotation.sql:24-27`),
while the admin UI says the current key is revoked
(`apps/admin/src/pages/merchants/MerchantDetailPage.tsx:539`).  
**Why it matters:** Rotation is a security incident response. The compromised
key continues to have full merchant authority indefinitely.  
**Suggested fix:** Revoke the old key in the same transaction (set
`revoked_at = now()` and `revoked_reason = 'rotated'`), then add a regression
test that authenticates with the old key and expects 401.  
**Confidence:** High.

### H-2. Payment-link public read leaks the merchant’s API-key prefix and hash
**Location:** `apps/api/src/paymentLinks/read.ts:40-49,70-75`  
**What is wrong:** The unauthenticated `GET /v1/payment-links/:token` joins the
latest active API key and returns `ak.key_prefix AS merchant_public_key` and
`ak.key_hash AS integration_id` in the public DTO. The file’s own DTO comment
says the public shape contains nothing that identifies or authenticates the
merchant beyond the display name. The route test currently asserts the leak
(`apps/api/src/routes/paymentLinks.test.ts:126`).  
**Why it matters:** `key_hash` is the sha-256 of a bearer credential. It should
never leave the platform. Even though the raw key has 192 random bits, exposing
the hash gives an offline verifier and leaks a stable secret-derived
identifier to every buyer. The public endpoint should return only the fields the
checkout page needs.  
**Suggested fix:** Remove both fields from the public DTO and the SQL; update
the test to assert they are absent. If an offline terminal needs a public
merchant identifier, create a separate explicitly-public identifier.  
**Confidence:** High.

### H-3. Any merchant’s API key can bypass payment-link expiry
**Location:** `apps/api/src/routes/paymentLinks.ts:68-77,184-189`  
**What is wrong:** `hasValidApiKey` only asks whether the Bearer token resolves
to *some* merchant. It then trusts the client-supplied `submittedAt` for the
expiry check. There is no comparison between the key’s `merchantId` and the
payment link’s merchant.  
**Why it matters:** An attacker can register their own merchant, obtain an API
key, and then pay another merchant’s expired link with a fabricated pre-expiry
timestamp. The offline-terminal exception is meant for the link’s own
merchant/terminal, not for any platform tenant.  
**Suggested fix:** Have `hasValidApiKey` return the resolved merchant context,
load the link’s `merchant_id`, and only honor `submittedAt` when they match.
Otherwise use server time.  
**Confidence:** High.

### H-4. Impersonation is not read-only on the merchant write routes
**Location:** `apps/api/src/auth/requireMerchantAuth.ts:85-99,127-132`;
`apps/api/src/routes/transactions.ts:95,123`;
`apps/api/src/routes/refunds.ts:21`.  
**What is wrong:** An impersonation grant always has merchant role `support`,
but the capture, void and refund routes check only `requireMerchantAuth`. They
do not call `requireMerchantRole("owner","finance")`. The writer helper then
records the impersonated write as `merchant_session`, so the audit trail cannot
tell the admin operator from the merchant. The code comments say
“impersonation can’t reach write routes”; that is false for these routes. A
support-level merchant session can also capture/void/refund, which the product
UI hides but the API does not enforce.  
**Why it matters:** A view-only admin can move money as the merchant with no
admin attribution. That directly contradicts B20 and the admin console banner.  
**Suggested fix:** Add a `requireMerchantSessionRole` / forbid
`actorType === "admin_impersonation"` guard to every money-moving route, or
gate capture/void/refund to owner/finance. If impersonation writes are ever
allowed, persist an explicit `admin_impersonation` actor and audit row.  
**Confidence:** High.

### H-5. “View as merchant” cannot actually open the merchant dashboard
**Location:** `apps/api/src/routes/auth.ts:255-257` (`GET /v1/auth/me` uses
`requireSession`, not `requireMerchantAuth`); `apps/web/src/auth/DashboardAuthContext.tsx`
calls `me()` on mount.  
**What is wrong:** `requireMerchantAuth` supports the `fp_impersonation` cookie,
but `/v1/auth/me` uses `requireSession`, which only accepts a real merchant
session cookie. The impersonation cookie therefore cannot pass the dashboard’s
first request: the web app gets 401, marks itself anonymous, and redirects to
the merchant login page.  
**Why it matters:** The admin console’s main “View as merchant” feature is
non-functional end to end. This is the route the legacy comment says is the one
place still using `requireSession` after B12.  
**Suggested fix:** Use `requireMerchantAuth` (or a dedicated
`requireSessionOrImpersonation`) for `/auth/me`, and return the merchant
identity for a valid grant. Keep `requireSession` for logout/login-only paths.  
**Confidence:** High.

### H-6. Merchant OTP is issued to a different merchant’s user with the same email
**Location:** `apps/api/src/routes/auth.ts:74-88`; `apps/api/src/auth/users.ts:11-24`;
seed deliberately has the same owner email in Alpha and Beta
(`db/seed/fixtures/merchants.ts:118-123`).  
**What is wrong:** Login verifies the password for the exact
`(merchant_id, email)` row, then resolves the OTP recipient with
`findOtpRecipient(app.db, email)`, a query that searches **all active
merchants** and has no `ORDER BY`. The challenge and pending session are created
for that recipient, not for the user whose password was verified. With the seed
data, logging in with Beta’s `merchantId` and the shared
`owner@alpharetail.example` address can create the session for Alpha’s user and
return Alpha’s `merchantId` after OTP.  
**Why it matters:** Cross-tenant session confusion / account takeover whenever
two tenants share an email (the schema explicitly allows this; it is why login
takes a `merchantId`). The password check becomes irrelevant to the identity of
the session.  
**Suggested fix:** Always use `user` from the password lookup; delete
`findOtpRecipient` from the login path (or constrain it by
`mu.merchant_id = $merchantId`). Add a regression test with two merchants
sharing one email and assert the returned merchant is the requested one.  
**Confidence:** High.

### H-7. OTP verification has a check-then-increment race
**Location:** `apps/api/src/routes/auth.ts:136-167`;
`apps/api/src/routes/adminAuth.ts:134-163`.  
**What is wrong:** The challenge is read with a plain `SELECT`, the
`attempt_count` is checked, the code is verified, and only then is
`attempt_count = attempt_count + 1` executed on failure. There is no row lock
and no atomic set-based guard. The code comment itself says “if I fire 50 at
once they all read attempt_count=0”. Fifty concurrent guesses can therefore all
be evaluated against one 5-attempt budget (and concurrent correct guesses can
all promote).  
**Why it matters:** The OTP second factor can be brute-forced in parallel; the
admin plane is the higher-privilege case.  
**Suggested fix:** Claim the challenge with one atomic statement (e.g.
`SELECT ... FOR UPDATE` inside the transaction or
`UPDATE ... SET attempt_count = attempt_count + 1 WHERE id=$1 AND attempt_count < max_attempts RETURNING ...`)
before verifying; only one row/attempt can win. Add a concurrent test.  
**Confidence:** High.

### H-8. OTP resend resets the guess budget (contrary to its own comment)
**Location:** `apps/api/src/routes/auth.ts:196-239`  
**What is wrong:** The resend endpoint creates a **new** `otp_challenges` row
via `issueChallenge`; the new row gets `attempt_count = 0`. The comment says
the new challenge inherits the previous challenge’s `attempt_count`, but no such
copy exists. An attacker with a pending session can resend every 30 seconds and
keep resetting the five-guess budget.  
**Why it matters:** Makes the OTP rate limit ineffective and compounds H-7.  
**Suggested fix:** Copy the old `attempt_count` (and the old `max_attempts`) into
the new challenge, or keep the same challenge row and only rotate the code;
never reset the counter.  
**Confidence:** High.

### H-9. Merchant OTP success does not reissue the session cookie
**Location:** `apps/api/src/routes/auth.ts:99-105` sets the pending cookie with
`maxAge: pendingSessionTtlMinutes * 60`; verification promotes the server session
to `sessionTtlHours` but does not set a new cookie
(`apps/api/src/routes/auth.ts:171-185`). The admin path does reissue
(`apps/api/src/routes/adminAuth.ts:179-187`).  
**What is wrong:** The browser cookie keeps the 10-minute pending lifetime even
though the database session is valid for 12 hours. Users are logged out after
about 10 minutes.  
**Why it matters:** Functional authentication failure (the login page comment
already records the symptom).  
**Suggested fix:** Reissue the cookie with `sessionTtlHours` after successful
promotion, exactly as the admin verify path does.  
**Confidence:** High.

### H-10. Session fixation: OTP promotion does not rotate the session token
**Location:** `apps/api/src/auth/sessions.ts:51-66`;
`apps/api/src/adminAuth/sessions.ts:67-77`.  
**What is wrong:** The raw token generated at login is reused when the pending
session becomes authenticated. An attacker who can plant a `fp_sid` /
`fp_admin_sid` cookie in the victim’s browser before OTP verification holds the
token that will become the victim’s authenticated session.  
**Why it matters:** The comments in both files acknowledge the problem; it is
still unfixed.  
**Suggested fix:** On promotion, generate a fresh token, replace `token_hash`,
set the new cookie, and revoke/replace the old pending row (or delete and insert
a new authenticated session).  
**Confidence:** High (acknowledged in code comments).

### H-11. Disabled admins keep working impersonation grants
**Location:** `apps/api/src/admin/impersonation.ts:109-124`  
**What is wrong:** `lookupImpersonationGrant` joins `admin_users` but never
checks `au.status = 'active'`. A grant issued before the admin was disabled
continues to resolve until its 15-minute expiry.  
**Why it matters:** Disabling a staff account is expected to kill its access
immediately; the normal admin-session lookup does check this
(`apps/api/src/adminAuth/sessions.ts`).  
**Suggested fix:** Add `AND au.status = 'active'` to the lookup, and/or revoke
all live grants when an admin is disabled.  
**Confidence:** High (acknowledged in the code comment).

### H-12. Acquirer callbacks are unsigned by default and have no timestamp window
**Location:** `apps/api/src/config.ts` defaults
`acquirerCallbackRequireSignature` from `parseBoolEnv(env, false)`;
`apps/api/src/webhooks/inboundVerify.ts:45-69` returns `{valid:true}` when no
header is present and the flag is false; the route test locks that behavior
(`apps/api/src/routes/acquirerCallbacks.test.ts:171-187`).  
**What is wrong:** Unless `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true` is set, a
caller can post a forged `fraud_review.completed` callback. Even when a
signature is present, the timestamp `t` is parsed but never compared with the
server clock, so a captured signed callback can be replayed indefinitely (the
dedup only covers that one callback id).  
**Why it matters:** A forged callback can change the notes support/finance use
for a transaction; a replay can re-apply a verdict. The shipped
`ops/.env.docker` sets the flag, but the secure default is not enforced by
`NODE_ENV=production`.  
**Suggested fix:** Require a signature whenever a signing secret is configured,
enforce a tolerance window (like `verifySignature`), and compare over the raw
request bytes.  
**Confidence:** High.

### H-13. Inbound acquirer signature is computed over a re-serialized object, not the raw bytes
**Location:** `apps/api/src/webhooks/inboundVerify.ts:56-62`; the route parses
the JSON body before calling it (`apps/api/src/routes/acquirerCallbacks.ts:39-55`).  
**What is wrong:** `JSON.stringify(payload)` is not guaranteed to reproduce the
bytes the acquirer signed (key order, whitespace, escaping). The outbound B11
fix was specifically about signing the exact bytes on the wire; the inbound
side still does the same canonicalization the outbound fix rejected.  
**Why it matters:** A compliant acquirer that signs its raw request body will
get `signature_mismatch`; a JSON reorder that preserves semantics can change the
HMAC.  
**Suggested fix:** Capture the raw body (Fastify raw-body parser / `onRequest`
buffer) and verify over those exact bytes.  
**Confidence:** High as a correctness/security defect; the sandbox happens to
serialize the same way, which is why the local tests pass.

---

## 3. High-value authorization and payment-link defects

### P-1. Payment-link flow is not one transaction; a crash/finalize failure can charge twice
**Location:** `apps/api/src/paymentLinks/pay.ts:69-186` (outer
`withTransaction`), `99-110` (`authorizeTransaction(pool, ...)`), `127-133`
(`captureTransaction(pool, ...)`).  
**What is wrong:** The outer transaction holds the `payment_links` row lock and
claims the link, but `authorizeTransaction` and `captureTransaction` each open a
**new** `withTransaction` on the pool and commit independently. The comment
“the whole flow runs in ONE transaction” is false. Consequences:
- crash after capture commit but before finalize commit: outer transaction rolls
  back, link returns to `active`, capture remains; a second buyer can pay and be
  charged too;
- finalize 0-row path returns 409 but does **not** void the capture (despite the
  B15 explanation saying it does);
- capture decline/error path releases the link but leaves the authorized
  transaction and its active hold behind.  
**Why it matters:** This is the exact incident class (one link, two buyers /
orphan captures) and it also leaves holds that may later be captured.  
**Suggested fix:** Run the authorize/capture/finalize work on the **same**
`PoolClient` inside the outer transaction (or make the inner functions accept a
client), and void the transaction/hold on any finalize failure or capture
failure. The reserve/claim row lock should protect a single atomic commit, not
just the lock’s duration.  
**Confidence:** High.

### P-2. Public payment-link page has no `Cache-Control: no-store`
**Location:** `apps/api/src/paymentLinks/read.ts` (public read),
`apps/api/src/routes/paymentLinks.ts` (no cache header),
`apps/web/src/api/paymentLinks.ts` / `CheckoutPage.tsx` (no cache control).  
**What is wrong:** The incident postmortem lists action item 6, “`Cache-Control:
no-store` on the hosted link page”, as Done, but there is no such header or
directive anywhere in the current code. A browser/proxy can serve a stale
checkout page whose status was `active` before the link was paid.  
**Why it matters:** This is exactly the FP-PL-8902 after-the-fix double-payment
scenario; the API may reject the second pay, but the buyer is shown a stale
page and retries/caches can make the experience unsafe.  
**Suggested fix:** Send `Cache-Control: no-store` on the public link read/pay
responses and add a `<meta http-equiv="cache-control" ...>`/fetch option on the
checkout page.  
**Confidence:** High.

### P-3. Public payment-link read returns more fields than the checkout contract
**Location:** `apps/api/src/paymentLinks/read.ts:20-30,62-76`;
`apps/web/src/types.ts` public DTO does not include the extra fields.  
**What is wrong:** `merchantPublicKey` and `merchantIntegrationId` are returned
to unauthenticated callers (see H-2). Even if the hash is removed, the public
read should not expose key material or internal API-key identifiers.  
**Why it matters:** Secret-adjacent data in a public response; the test currently
pins one of them.  
**Suggested fix:** Return only `token`, `amountFils`, `currency`,
`merchantDisplayName`, `reference`, `description`, `status`, `expiresAt`, as the
web type expects.  
**Confidence:** High.

### P-4. Capture/void/refund routes allow a support session (and impersonation) to move money
**Location:** `apps/api/src/routes/transactions.ts:95,123`;
`apps/api/src/routes/refunds.ts:21`; `apps/api/src/auth/requireMerchantAuth.ts:127-132`.  
**What is wrong:** The routes use only `requireMerchantAuth`, which accepts a
merchant `support` session, an API key, or an admin impersonation with role
`support`. `requireMerchantWriterActor` records impersonation as
`merchant_session`. The UI hides the buttons for support but explicitly says
that is not a security boundary.  
**Why it matters:** Least-privilege merchant roles are not enforced server-side
for the most money-sensitive merchant actions.  
**Suggested fix:** Add `requireMerchantRole("owner","finance")` to capture,
void and refund (and any future write), and reject `admin_impersonation` from
writes. If support is meant to void small transactions, make that explicit with
a separate permission rather than “any authenticated actor”.  
**Confidence:** High.

---

## 4. High/Medium correctness and money-path defects

### M-1. Admin credit effective dates can be in the future; future-dated ledger rows are posted
**Location:** `apps/api/src/admin/creditRequestValidation.ts:12-13,76-84`  
**What is wrong:** The JSDoc says `effectiveDate` is validated to be today or
earlier and future dates are rejected, but the function only checks that it is a
real calendar date. A credit with `effectiveDate` in 2027 is accepted and
`postCreditToLedger` writes ledger legs at that future Bahrain midnight.  
**Why it matters:** Future-dated liabilities appear in the ledger, break
period reports, and can be manipulated by an operator.  
**Suggested fix:** Compare the date against the current Asia/Bahrain calendar
date in the validator (or in the route with an explicit error code); add a test
with `isoDaysFromToday(1)`.  
**Confidence:** High.

### M-2. Admin credit fee reversal uses `merchants.mdr_bps`, not the effective fee schedule
**Location:** `apps/api/src/admin/credits.ts:212-224`  
**What is wrong:** The reversal is `applyRateFils(base, merchant.mdr_bps)`.
Billing (`capture.ts`) and settlement resolve the negotiated rate from
`fee_schedules` (effective-dated). A merchant whose contracted rate is 225 bps
but whose legacy `mdr_bps` is 250 gets a credit reversal 25 bps too high (or too
low), so the credit and the actual fee disagree.  
**Why it matters:** Manual credits are money-moving; the reversal should match
what the platform actually charged.  
**Suggested fix:** Resolve the same effective schedule as capture (as of the
credit’s effective date or now, per finance rule) and compute from that.  
**Confidence:** High.

### M-3. Recompute transaction statuses can clear a test merchant’s `test_mode`
**Location:** `apps/api/src/admin/transactionStatusRecompute.ts:27-50`;
`apps/api/src/admin/merchantFlags.ts:9-18`.  
**What is wrong:** The candidates query explicitly excludes
`status IN ('authorized','voided')`, but the loop increments
`openAuthorizations` only when `row.status === "authorized"`. It is therefore
always `0`. `reconcileSandboxFlag` clears `test_mode` whenever
`scanned > 0 && openAuthorizations === 0`. A sandbox merchant with open auths
gets promoted out of test mode. The seed chat even records Gamma saying
`testModeCleared: true` after this action.  
**Why it matters:** A test merchant can enter real settlement, exactly B19’s
failure mode, through an admin button.  
**Suggested fix:** Count open authorizations with a separate query before the
candidate filter, or include `authorized` rows in the scan and only use the
other statuses for the update. Do not clear `test_mode` from a count that cannot
see the rows it is counting.  
**Confidence:** High.

### M-4. Bulk KYC approval approves every selected merchant regardless of status
**Location:** `apps/api/src/admin/bulkKyc.ts:21-44`; the admin UI comment even
says “only approves the under_review ones (filtered)” but the server sends all
selected ids (`apps/admin/src/pages/merchants/MerchantListPage.tsx:83-84`).  
**What is wrong:** The `UPDATE` has `WHERE id = ANY($1)` only. It re-approves
already-approved merchants and **approves rejected merchants**, and it does not
insert `merchant_kyc_reviews` rows (the single-review path does). The documented
contract is “only merchants currently `under_review` are affected”.  
**Why it matters:** KYC is a compliance control; a bulk button must not
reverse a rejection or approve a merchant that never passed review.  
**Suggested fix:** Add `AND onboarding_status = 'under_review'`, return only the
rows that actually moved, and insert one review row per merchant (or route
through `recordKycReviewInTx`).  
**Confidence:** High.

### M-5. Rebuild-all-balances has no row locks and can clobber concurrent close/payout deltas
**Location:** `apps/settlement/internal/ledger/rebuild.go:57-130` (TODO at line
89); `internal/balances/cache.go:25-50`.  
**What is wrong:** `RebuildAllBalances` reads each cached value, computes the
ledger rollup, and writes the absolute value. A concurrent `CloseBatch` or
`PayoutBatch` increment can land between the read and the write, so the rebuild
erases it. The code itself has a TODO: “lock merchant_balances rows first, a
concurrent CloseBatch increment gets clobbered”.  
**Why it matters:** The admin button is supposed to be safe; a rebuild during
the nightly close can understate or overstate a merchant’s payable.  
**Suggested fix:** Lock the `merchant_balances` rows (`SELECT ... FOR UPDATE`)
in the same transaction as the read/write, or use an advisory lock that is
shared with the incremental writers.  
**Confidence:** High (acknowledged in code).

### M-6. `settlement rebuild-balances --merchant=<uuid>` never updates the cache
**Location:** `apps/settlement/cmd/settlement/main.go:149-161`;
`apps/settlement/internal/ledger/rebuild.go:20-35`.  
**What is wrong:** The single-merchant branch calls `RebuildMerchantBalance`,
which only runs the aggregate and returns the value. It never executes an
`INSERT/UPDATE merchant_balances`. The CLI prints the value and exits. The
runbook tells operators this command fixes a merchant’s balance.  
**Why it matters:** The documented recovery command is a no-op for the cache;
operators believe they fixed the balance when they did not.  
**Suggested fix:** Write the computed value to `merchant_balances` in a
transaction (or call a single-merchant variant of `RebuildAllBalances`).  
**Confidence:** High.

### M-7. `RefreshBalanceCache` still uses the old scheme-gross source
**Location:** `apps/settlement/internal/ledger/refresh.go:17-90` (reads
`merchant_payable_position`, which sums `scheme_export_lines` gross).  
**What is wrong:** This is the exact wrong-source path B7 describes. It is not
currently wired into the admin route, but it remains exported and has tests, so
any future caller or external tool can reintroduce the 135K→7K bug.  
**Why it matters:** Dead/legacy path with wrong money semantics; the tests keep
it alive.  
**Suggested fix:** Delete it or make it delegate to `RebuildAllBalances`.  
**Confidence:** High for the wrong source; low for current user impact.

### M-8. MDR recalculation ignores fee schedules and the platform volume tier
**Location:** `apps/settlement/internal/settlement/recalculate_mdr.go:56-132`  
**What is wrong:** The recalculation loads `merchants.mdr_bps` /
`negotiated_discount_bps` and recomputes every event with those values. It does
not resolve `fee_schedules` at the event time (the authoritative negotiated
rate), and it does not subtract the platform volume-tier bonus that `CloseBatch`
applies. Meanwhile the admin UI says “recalculate at their current contracted
rate”. A merchant with a 225 bps schedule and legacy `mdr_bps` 250 gets a
250 bps recalculation, and the batch no longer matches a fresh close.  
**Why it matters:** The admin action rewrites fee history and posts ledger
adjustments using a different formula from the one it claims to mirror.  
**Suggested fix:** Reuse `LoadFeeSchedules`/`EffectiveMdrBpsAt`, apply the same
tier bonus logic, and compare against the exact `CloseBatch` formula before
posting. Add a test with a fee schedule and with the tier active.  
**Confidence:** High.

### M-9. Go fee-schedule resolution has no `created_at` tie-break
**Location:** `apps/settlement/internal/settlement/fee_schedule.go:29-41`  
**What is wrong:** `LoadFeeSchedules` orders by `effective_from ASC` only, and
`EffectiveMdrBpsAt` walks from the end. The TS path orders by
`effective_from DESC, created_at DESC`. Two rows with the same
`effective_from` (the backfill scenario the seed deliberately creates for
alpha) can resolve differently between capture and settlement.  
**Why it matters:** The same capture can be billed at one rate and settled at
another; B6’s rule is explicitly that both readers must agree.  
**Suggested fix:** Include `created_at` in the Go rows and order by
`effective_from ASC, created_at ASC`, then walk from the end (or mirror the TS
ordering exactly).  
**Confidence:** High.

### M-10. Reconciliation’s pending estimate uses the current rate, not the event’s rate
**Location:** `apps/api/src/settlement/query.ts:329-341`  
**What is wrong:** `pendingUnbatchedFils` resolves one current schedule row and
applies `estimateFeeFils` to every unbatched event. The actual settlement will
resolve each event’s own `occurred_at` schedule (and the tier), so a period
spanning a rate change produces a “pending” figure that cannot match the batch
that will eventually be created.  
**Why it matters:** The reconciliation report reports an unexplained gap even
when the ledger and future batch are correct.  
**Suggested fix:** Join `fee_schedules` per event (or fetch schedules once and
resolve in application code, as CloseBatch does) and use the exact per-event
formula.  
**Confidence:** High.

### M-11. Partial-refund fee reversals can sum above/below the original fee
**Location:** `packages/money/src/fils.ts` (`calculateRefundFee`), called from
`apps/api/src/payments/processRefund.ts:182`.  
**What is wrong:** Each partial refund rounds independently. For example,
captured `3` fils with fee `2` refunded as `1 + 1 + 1` reverses `1 + 1 + 1 = 3`
fils, more than the `2` actually charged. At realistic small amounts the
opposite can happen: a small fee can be rounded to `0` on every partial and
never fully reversed. The finance note requires the total reversal never to
exceed the original fee.  
**Why it matters:** The merchant can be under- or over-credited over a sequence
of partial refunds; the ledger still balances, so the error is easy to miss.  
**Suggested fix:** Track the fee already reversed per transaction and cap the
new reversal at `feeCharged − feeAlreadyReversed` (or compute the cumulative
reversal from the cumulative refunded total).  
**Confidence:** High (constructible counterexample).

### M-12. `refund_merchant_summary` overcounts `original_captured_fils` on multiple refunds
**Location:** `db/migrations/0072_refund_merchant_summary.sql:12`  
**What is wrong:** The view groups refunds and sums `t.captured_fils`. If the
same transaction has two partial refunds on the same day, the original captured
total is added twice.  
**Why it matters:** The finance refund summary overstates the original captures
and makes refund ratios wrong.  
**Suggested fix:** Use a `COUNT(DISTINCT r.transaction_id)`-based subquery or
`MAX(t.captured_fils)` per transaction; do not sum the captured total across
refund rows.  
**Confidence:** High.

---

## 5. Reliability / concurrency

### R-1. Reporting consumer cursor has no row lock; catch-up/admin rebuild can double-apply events
**Location:** `apps/reporting/src/consumer/cursor.ts:24-38`;
`apps/reporting/src/consumer/runConsumerPass.ts:39-68`;
`apps/reporting/src/cli/catchUp.ts:16-27`;
`apps/reporting/src/cli/rebuild.ts:45-62`.  
**What is wrong:** `runConsumerPass` reads `reporting_outbox_cursor` with a
plain `SELECT`, applies a batch, then writes an absolute `last_processed_id`.
Two passes (live worker + `reporting catch-up`, or admin “Rebuild analytics” +
worker) can read the same watermark and both increment the additive
`merchant_daily_volume` counters. The RUNBOOK says catch-up is safe while the
worker is up; the code comment even says the `running` flag in one process
guards it, which does not cover a second process.  
**Why it matters:** Analytics can double-count captures, refunds and payouts;
a rebuild can race the worker and leave partial/stale data.  
**Suggested fix:** Lock the cursor row (`SELECT ... FOR UPDATE`) for the whole
pass, or atomically claim the next batch with a single `UPDATE ... RETURNING`
watermark; make rebuild take an exclusive lock/flag.  
**Confidence:** High.

### R-2. Admin “Rebuild analytics” is not atomic with the actual rebuild
**Location:** `apps/api/src/admin/reportingRebuild.ts:26-42`;
`apps/api/src/routes/admin.ts` reporting rebuild handler.  
**What is wrong:** The route opens a `withTransaction` on the API pool, then
`refreshAnalyticsRollups` calls `runRebuild` with a **different** pool. The
rebuild truncates the rollups and replays the outbox in its own transactions.
If replay fails or the API transaction later rolls back, the audit row is rolled
back but the rollups have already been truncated/partially rebuilt. It also
races a live reporting worker (R-1).  
**Why it matters:** A failed admin rebuild can leave the dashboards empty or
half-replayed, with no audit record of the failure.  
**Suggested fix:** Perform the rebuild in the same transaction/connection, or
have a single rebuild job own the cursor/truncate and write an audit row after
success; take the same lock as R-1.  
**Confidence:** High.

### R-3. Webhook dispatcher can send duplicate deliveries with more than one API replica
**Location:** `apps/api/src/webhooks/dispatcher.ts:226-260`  
**What is wrong:** `attemptDueDeliveries` selects due `pending` rows with a
plain `SELECT ... LIMIT`, no `FOR UPDATE`, no `SKIP LOCKED`, no claim/in-progress
state. Two API processes (the comments say staging ran two replicas) can select
and send the same row, incrementing attempts and potentially delivering twice.  
**Why it matters:** B17’s duplicate payout/disbursement class; at-least-once is
fine only if the receiver dedupes, but the dispatcher also runs the
`settlement.paid` pre-delivery effect on `attempt_count = 0`, so two replicas
can both run it (the table unique index saves the disbursement row, not the
webhook send).  
**Suggested fix:** Claim rows atomically (`UPDATE ... SET status='in_progress'
WHERE id IN (...) RETURNING ...` or `SELECT ... FOR UPDATE SKIP LOCKED`) before
sending; only one dispatcher may own a row per attempt.  
**Confidence:** High.

### R-4. Webhook secret encryption has no key version/rotation path
**Location:** `apps/api/src/webhooks/secretCrypto.ts` (single AES-GCM key, IV +
tag + ciphertext only); `apps/api/src/webhooks/dispatcher.ts:155-175` catches
decrypt errors per row and leaves the delivery pending forever.  
**What is wrong:** The ciphertext does not record which encryption key produced
it. Rotating `WEBHOOK_SECRET_ENCRYPTION_KEY` makes every stored secret
undecryptable; the dispatcher catches the error, logs it, and retries the same
row forever. There is no key-id, previous-key window, or re-encrypt job. This is
B21, still open.  
**Why it matters:** A routine key rotation silently freezes webhook delivery for
every merchant, with no alert and no recovery path.  
**Suggested fix:** Prefix ciphertext with a key id, accept the previous key dur
a cutover, re-encrypt all endpoint secrets, and alert on decrypt failures.  
**Confidence:** High (acknowledged in EXPLANATIONS B21).

### R-5. Webhook test-send can be pointed at internal services; redirects are followed
**Location:** `apps/api/src/webhooks/create.ts:15-29` only checks the URL scheme;
`apps/api/src/webhooks/update.ts` reuses it; `apps/api/src/webhooks/transport.ts:39-49`
uses `fetch` with default redirect following and reads the entire response
body; `apps/api/src/webhooks/testSend.ts:70-72` returns the first 2 KB to the
caller.  
**What is wrong:** The comment says “create.ts blocks private hosts in
production”, but no host/IP validation exists. A merchant can register an
internal HTTPS URL (or a public URL that redirects to one) and use “send test
event” to read the response excerpt. The transport also has no response-size
limit, so a hostile receiver can make the API buffer a very large body.  
**Why it matters:** SSRF / internal network probing and a memory DoS on the
512 MB API container; the test-send echo turns SSRF into a data-exfiltration
primitive.  
**Suggested fix:** Resolve the hostname and block loopback/private/link-local
ranges, set `redirect: "manual"` (or re-validate every redirect), cap response
bytes, and do not return response bodies from test-send for non-public targets.  
**Confidence:** High.

### R-6. Webhook endpoint deletion fails with a 500 when the endpoint has deliveries/archives
**Location:** `apps/api/src/webhooks/cancel.ts:17-25`;
`db/migrations/0022_webhook_deliveries.sql:6` (`endpoint_id ... REFERENCES
webhook_endpoints(id)` with no `ON DELETE`); `db/migrations/0068_webhook_delivery_archives.sql:13`
has the same. The code comment says “FK is ON DELETE SET NULL (0029)”, but 0029
is a payment-link index, not this FK.  
**What is wrong:** `DELETE FROM webhook_endpoints` hits `23503` when any
`webhook_deliveries` or `webhook_delivery_archives` row references it, and the
error handler returns 500. The CRUD test only deletes a fresh endpoint with no
deliveries, so it does not catch this.  
**Why it matters:** Merchants cannot delete an endpoint after it has ever sent a
webhook, which is the normal case.  
**Suggested fix:** Add the missing `ON DELETE SET NULL` (and make the column
nullable) or soft-delete the endpoint while retaining deliveries. Add a test
that dispatches one delivery and then deletes the endpoint.  
**Confidence:** High.

### R-7. Webhook archive creation/restore loads the whole range into memory
**Location:** `apps/api/src/webhooks/archiveReplay.ts:40-90,120-160`  
**What is wrong:** `createWebhookDeliveryArchive` runs one unbounded `SELECT`
over the date range, maps every row into an array, `JSON.stringify`s it, and
stores it in one `TEXT` column. The same for restore. ADMIN.md says archives
are “written in pages of 1000 deliveries”, but there is no paging. A large
endpoint history can OOM the 512 MB API and create an enormous single row.  
**Why it matters:** Admin archive is exactly for old/high-volume history, so it
is most likely to hit the largest result set.  
**Suggested fix:** Page the query with a keyset, write pages (or a compressed
stream), and restore page-by-page; add a row/bytes cap or a background job.  
**Confidence:** High.

## 6. Medium security / input-validation defects

### S-1. KYC PDF-only check uses the filename, not the detected magic bytes
**Location:** `apps/api/src/onboarding/kyc.ts:60-72`  
**What is wrong:** `recordKycDocument` already computes `detected` from the
bytes, but the PDF-only rule for `commercial_registration`/`bank_letter` checks
`input.fileName.toLowerCase().endsWith(".pdf")`. A JPEG named `cr.pdf` passes;
a real PDF named `scan.jpg` is rejected. The route comment says the rule is
enforced on magic bytes.  
**Why it matters:** A merchant can submit a photo where a registry PDF is
required, defeating the compliance control.  
**Suggested fix:** `if (PDF_ONLY_DOCUMENT_TYPES.includes(type) && detected !== "pdf")` reject; do not use the filename for validation.  
**Confidence:** High.

### S-2. KYC thumbnailing has no `limitInputPixels`
**Location:** `apps/api/src/onboarding/kycThumbnail.ts:23-37`  
**What is wrong:** `sharp(buffer).resize(...)` runs without
`limitInputPixels`; Sharp’s default is large (~268 MP). An 8 MiB compressed
PNG can decompress to hundreds of megapixels and consume most of the 512 MB
container before resize. The code comment itself flags this.  
**Why it matters:** Authenticated merchant can DoS the API with a crafted
upload.  
**Suggested fix:** Set `limitInputPixels` to a small bound appropriate for KYC
documents, and reject images above it with 422.  
**Confidence:** High.

### S-3. CSV exports allow spreadsheet formula injection via `reference`
**Location:** `apps/api/src/transactions/exportCsv.ts:9-28`  
**What is wrong:** `csvEscape` quotes commas/quotes/newlines but does not
neutralize cells beginning with `=`, `+`, `-`, or `@`. A merchant can put
`=HYPERLINK(...)` or `=cmd|...` in a transaction reference; finance opens the
export in Excel and executes the formula. The test file even notes “no test for
a reference starting with `=`”.  
**Why it matters:** CSV injection against finance staff; real data exfiltration
/ command execution on their machine.  
**Suggested fix:** Prefix a single quote or otherwise escape formula-leading
characters (at least `= + - @ \t \r`), and add tests.  
**Confidence:** High.

### S-4. Invalid path UUIDs, limits and dates produce 500s instead of 400/404
**Location:** examples:
- `apps/api/src/routes/transactions.ts:140,145,173` (`limit`, `from`, `to`);
- `apps/api/src/routes/settlement.ts:44,48-49,101,118`;
- `apps/api/src/routes/paymentLinks.ts:145`;
- `apps/api/src/routes/webhooks.ts:195`;
- `apps/api/src/routes/refunds.ts` (`transactionId` passed to UUID query);
- `apps/api/src/routes/auth.ts:64-69` (`merchantId` not UUID-validated);
- `apps/api/src/routes/apiKeys.ts`, `businessProfile.ts`, `kyc.ts` path ids.
**What is wrong:** Many routes parse `limit` with `Number.parseInt` and pass
`NaN`, or build a `Date` from arbitrary query text, or pass arbitrary text to a
UUID column. PostgreSQL then raises a cast/syntax error and the generic handler
returns 500. `getReconciliationReport`’s `bahrainLocalMidnightUtc` throws a
`RangeError` for an invalid date.  
**Why it matters:** Bad client input is reported as a server fault; clients
cannot distinguish a typo from a real outage.  
**Suggested fix:** Validate UUIDs with the existing `UUID_RE`/`assertUuidParam`,
validate `limit` with `Number.isSafeInteger`, and reject invalid dates with
`invalid_date` 400.  
**Confidence:** High.

### S-5. `PATCH business-profile` with an unknown key produces a SQL error
**Location:** `apps/api/src/onboarding/businessProfile.ts:96-119`  
**What is wrong:** `Object.entries(patch)` includes unknown keys; `PATCHABLE_COLUMNS[key]` is
`undefined`, so the generated `SET undefined = $n` fails and returns 500. The
body is user-controlled JSON, not the TypeScript interface at runtime.  
**Why it matters:** A simple typo in a client request is a 500; it also makes
the endpoint brittle for future fields.  
**Suggested fix:** Reject keys not in `PATCHABLE_COLUMNS` with 400, and validate
types per field.  
**Confidence:** High.

### S-6. Analytics date validation accepts impossible dates such as `2026-02-30`
**Location:** `apps/api/src/routes/analytics.ts:27-31`  
**What is wrong:** `isValidDateString` uses `Date.parse`; JavaScript normalizes
`2026-02-30` to March 2 and returns a valid timestamp. The route then passes it
to `bahrainLocalMidnightUtc`/`addCalendarDays`, silently querying the wrong
days.  
**Why it matters:** A malformed report range silently returns a different period
instead of 400.  
**Suggested fix:** Round-trip the rendered date as
`creditRequestValidation.isRealCalendarDate` does, or construct with
`Date.UTC` and compare components.  
**Confidence:** High.

### S-7. `POST /v1/transactions` and `/capture` turn invalid amounts into 500s
**Location:** `apps/api/src/routes/transactions.ts:79,103`  
**What is wrong:** `toFils(amountFils)` is called without a try/catch. A
non-integer, negative, non-number, or unsafe-integer body throws `RangeError`
and the generic handler returns 500. The admin credit validator and payment-link
create path do this correctly; these two do not.  
**Why it matters:** A client validation error is reported as a server error, and
the amount contract is inconsistently enforced.  
**Suggested fix:** Catch `RangeError` and throw `BadRequestError("invalid_amount")`,
or validate with `Number.isSafeInteger` and `>=0` first.  
**Confidence:** High.

### S-8. Malformed card objects crash the acquirer simulator
**Location:** `apps/api/src/routes/transactions.ts:73-85`;
`apps/api/src/routes/paymentLinks.ts:168-175`;
`apps/api/src/acquirer/simulator.ts` (`req.card.pan.endsWith(...)`).  
**What is wrong:** The route only checks that `card` is truthy. `card = {}` or
`{ pan: null }` reaches the simulator and throws a `TypeError`, returning 500
instead of 400.  
**Why it matters:** Public checkout and authorize route can be crashed with a
malformed body; noisy 500s mask real errors.  
**Suggested fix:** Validate the `SimulatedCardInput` shape (PAN string, numeric
expiry, CVV string) at the route boundary.  
**Confidence:** High.

### S-9. Webhook test-send ignores endpoint status
**Location:** `apps/api/src/webhooks/testSend.ts:38-47` (selects `status` but
never checks it).  
**What is wrong:** A disabled endpoint can still receive a test event. The route
is owner/finance, so this is not a cross-tenant issue, but it contradicts the
“disabled means paused” lifecycle and can surprise a receiver whose URL was
disabled after a compromise.  
**Suggested fix:** Reject `status !== 'active'` with 409 `endpoint_disabled`,
consistent with replay.  
**Confidence:** High.

---

## 7. Lower-severity / operational findings

### L-1. `EstimateMonthlyPayout` still returns `float32`
**Location:** `apps/settlement/internal/settlement/payout_estimate.go:30-53`  
**What is wrong:** The lifetime accumulator was widened to `int64`, but the
monthly estimate still sums `float32(netFils)` and returns `float32`. If any
caller starts using it, large merchants drift past 2^24 fils.  
**Why it matters:** It is monitoring-only and currently has no callers, so the
runtime impact is latent, but it is the same class as B10 and contradicts the
“BIGINT everywhere” claim.  
**Suggested fix:** Return `money.Fils`/`int64` and sum integers.  
**Confidence:** High for the type defect; low for current impact.

### L-2. Seed writes the lifetime monitoring estimate through `Math.fround`
**Location:** `db/seed/generate.ts:661-669`  
**What is wrong:** It emulates the old `REAL` column even though migration 0074
widened the column to `BIGINT` and the Go updater now accumulates int64. Seeded
high-volume merchants get a float32-rounded estimate while a live run gives an
exact int64.  
**Why it matters:** Demo seed and live behaviour disagree; seed self-checks do
not cover this column.  
**Suggested fix:** Accumulate in `bigint`/safe integer and write the exact value.  
**Confidence:** High for inconsistency; low user impact.

### L-3. `refund_merchant_summary` is not truncated/refreshed by the seed or by a failed rebuild
**Location:** `db/seed/generate.ts` (`TABLES_TO_RESET` does not include the
matview); `apps/reporting/src/cli/rebuild.ts:45-62` truncates the two rollup
tables but not the matview (it refreshes only after replay).  
**What is wrong:** The materialized view can survive a reseed with rows from the
previous dataset, or a failed rebuild with rows from the pre-rebuild state.  
**Why it matters:** Refund reporting can show stale merchants/amounts after a
reset.  
**Suggested fix:** Include `REFRESH MATERIALIZED VIEW refund_merchant_summary`
after seed/reset and before/after rebuild, or truncate/rebuild the matview as
part of the same reset.  
**Confidence:** Medium.

### L-4. The `refunds` row never records its settlement batch
**Location:** `db/migrations/0042_refunds.sql` has
`refunds.settlement_batch_id` and an unbatched index, but nothing writes it.  
**What is wrong:** Even if C-2 is fixed later, the schema field intended to mark
a refund as settled is never populated, so the index for “unbatched refunds”
always contains every successful refund.  
**Why it matters:** Settlement accounting cannot distinguish settled from
unsettled refunds.  
**Suggested fix:** Set it inside the settlement transaction that nets the
refund, in the same update that claims the refund row.  
**Confidence:** High (schema/feature gap).

### L-5. `revoke_after` has no sweep job
**Location:** `db/migrations/0056_api_keys_revoke_after.sql:1-5`  
**What is wrong:** The column is added with a comment saying a sweep job revokes
expired keys, but no code reads `revoke_after`. Keys with a staged revocation
date never become revoked.  
**Why it matters:** A security feature that looks scheduled is inert.  
**Suggested fix:** Add a periodic job (or CHECK at auth time: `revoke_after IS
NULL OR revoke_after > now()`) and revoke accordingly; test it.  
**Confidence:** High for missing implementation; low if no one uses the column.

### L-6. Adjustment CSV imports are not idempotent
**Location:** `apps/api/src/admin/adjustmentImport.ts:63-64,75-120`; migration
0065 has no unique `original_filename`. The code comment says “re-upload is
blocked by the unique original_filename”, which is false. ADMIN.md admits “no
duplicate detection yet”; the finance Slack export records a double-post from
re-import.  
**What is wrong:** The same CSV applied twice posts every row twice (real
ledger entries). There is no idempotency key, file hash, or filename unique
constraint.  
**Why it matters:** A double-click can double a finance correction; it actually
happened in the August import.  
**Suggested fix:** Require an `Idempotency-Key`, or store a unique content hash
per uploader and reject duplicates; optionally add a preview/confirm step.  
**Confidence:** High (documented in finance chat).

### L-7. `SettlementBatchDetailPage` progress bar is mathematically meaningless
**Location:** `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx:83-90`  
**What is wrong:** `displayProgress = parseFloat((batch.grossFils / 10000).toFixed(2))`
and then `width: min(displayProgress,100)%`. It is a function of gross amount,
not completion or capacity; a 20,000 BD batch shows 200% (clamped to 100), a
500 BD batch shows 5%.  
**Why it matters:** UI-only, but it can mislead an operator about a closed
batch’s status.  
**Suggested fix:** Remove the bar for a closed batch or derive a real value
(e.g. captured vs authorized / batch event count).  
**Confidence:** High; low severity.

### L-8. `TransactionDetailPage` can send `amountFils: NaN`
**Location:** `apps/web/src/pages/transactions/TransactionDetailPage.tsx:65-73`  
**What is wrong:** The capture input is not validated with a regex; a non-empty
but non-numeric value becomes `Number(trimmed) = NaN`, which
`JSON.stringify` turns into `null`. The API then calls `toFils(null)` and
returns 500.  
**Why it matters:** A UI input error produces a server error; the browser shows
`describeError` on a 500.  
**Suggested fix:** Validate `Number.isSafeInteger` and > 0 before sending, the
same way `RefundDrawer` does.  
**Confidence:** High; low severity.

## 8. Functional/reporting gaps that are easy to miss

### F-2. The reporting consumer consumes refund events using the outbox row’s `created_at`, not the refund’s `occurred_at`
**Location:** `apps/reporting/src/consumer/applyEvent.ts:167-185`  
**What is wrong:** `applyDailySummaryRollup` receives `row.created_at`; a
refund whose outbox row is inserted after a retry/replay near midnight can be
bucketed into the next day.  
**Why it matters:** Daily refund counts can be one day off at the boundary.  
**Suggested fix:** Put `occurredAt` in the `refund.succeeded` payload and bucket
on that; fall back to `created_at` only for old events.  
**Confidence:** Medium.

## 9. Verified working / do not report as bugs

These were specifically checked against the current code and are either fixed,
intentionally accepted by `AGENTS.md`, or dead code with no callers. Listing
them here prevents false positives.

- **B1 CSV 10x** — fixed by `parseBhdToFils`; no current caller of
  `parseDecimalMinor` in the import path.
- **B3 scheme residue** — fixed and posted inside `CloseBatch`.
- **B4 paid-batch recalc** — query is now `status = 'closed'`.
- **B5 sweep idempotency/month** — fixed; the script uses the fixed +03:00
  month and a `NOT EXISTS` guard.
- **B6 fee display** — fixed (`effective_from <= now()` + correct ordering).
- **B7 balance button** — the admin handler uses `RebuildAllBalances` (the CLI
  `--merchant` gap is M-6, not a reason to call the button broken).
- **B8 refund ceiling** — uses `captured − refunded`.
- **B9 concurrent refunds** — one transaction + row lock across the acquirer
  call.
- **B11 outbound webhook sign-raw** — dispatcher signs the exact string sent.
- **B13 cancel scope** — `merchant_id` predicate is present.
- **B16 callback dedup** — unique pair + `ON CONFLICT`; the callback note
  dedup itself works (the unsigned/freshness issues are separate, H-12/H-13).
- **B18 Bahrain window** — normalized with `.In(Asia/Bahrain)`.
- **B19 test-mode settlement** — `CloseBatch` filters `test_mode = false`;
  seed skips ledger/settlement/outbox for Gamma.
- **B22 slow analytics** — bare `occurred_at` bounds and exclusive `to`.
- **B23 streaming export** — the route uses the keyset streamer; the
  non-streaming helper is unused. (CSV injection is S-3, separate.)
- **B24 Docker** — Dockerfiles/env_file/token wiring exist.
- **F1 refund route** — `/v1/refunds` is wired and the web drawer uses it.
- **F3 refund webhook** — envelope case and eligibility list both present.
- **F4 web drawer** — present; admin has no refund screen by design (documented).
- **F5 reason/matview join** — `reason` defaults to `unspecified`; join is
  `r.transaction_id`.
- **M2 flag/transmissions** — narrative only, not a code bug.
- **Pending-session view** — `live_sessions` includes `authenticated = true`.
- **`Math.random()` for payment-link slugs / OTP digits** — `AGENTS.md`
  explicitly states this is deliberate for non-security-critical tokens and
  uniqueness is enforced at the DB. I did not count it as a bug; if you want a
  hardening item, move link tokens to `crypto.randomBytes` (the ARCHITECTURE
  text claims 128-bit crypto, so the docs and code disagree).
- **`creditApproval.assertDistinctApprover` display-name comparison** —
  `AGENTS.md` says this matches the audit format deliberately. It is a design
  weakness (an admin can self-approve after a display-name change), but was not
  counted as a bug because the repository convention explicitly accepts it.
- **`calculateFeeV1` half-up, `parseDecimalMinor`, `parsePromotionalDiscountFils`,
  `transactionRoutesV1`, `getTransactionForReceipt`, `admin/inviteCode`** —
  dead/unwired code. They contain latent traps (e.g. `parseDecimalMinor`
  defaults to 2 decimals) but are not reachable from the running app, so they
  are not listed as live bugs. `RefreshBalanceCache` and
  `EstimateMonthlyPayout` are exported and tested, so they remain in the
  report as latent paths.
- **`.cursorrules` / `CLAUDE.md` claims** (cents instead of fils, UTC settlement
  windows, 501 refunds, float32 intentional, etc.) contradict the code,
  `AGENTS.md` and `ENGINEERING.md`. They are misleading guidance, not runtime
  bugs; do not use them as the source of truth.

---

## 10. Suggested fix order

1. C-1 (net payout float) and C-2 (refund settlement) — money correctness.
2. C-3/C-4 (summary/reconciliation) — finance cannot close the month otherwise.
3. H-1/H-2/H-3/H-4/H-6/H-7/H-10 — credential and authorization boundaries.
4. C-5/C-6/M-8/M-9 — one fee formula everywhere.
5. R-1/R-2/R-3/R-6 — concurrency and endpoint lifecycle.
6. H-12/H-13/R-4/R-5 — webhook/acquirer hardening.
7. The remaining validation, reporting and UI findings.
