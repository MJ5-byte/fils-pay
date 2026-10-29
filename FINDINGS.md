# FilsPay audit — findings

Scope: `apps/api`, `apps/settlement`, `apps/reporting`, `db/migrations`, `scripts`.
Rules used: the case file and `docs/adr/*` (1 BD = 1000 fils, integer fils only,
settlement day = Asia/Bahrain midnight). Where `CLAUDE.md` disagrees with them,
`CLAUDE.md` is wrong — see the last section.

Each entry: **where** · **what is wrong** · **why it happens** · **what it breaks** · **fix**.
Severity: 🔴 critical · 🟠 high · 🟡 medium.

---

## 1. Security

### 🔴 S-1 Login works without the OTP code
- **Where:** `apps/api/src/auth/sessions.ts` `lookupSession`
- **Wrong:** The query reads the `live_sessions` view and filters only on `token_hash`.
- **Why:** `live_sessions` (0058) hides revoked and expired rows but **not** `authenticated = false`. Step 1 of login (password only) already sets a session cookie for a pending session, and `requireMerchantAuth` / `requireSession` accept it. The 0012 migration comment and the admin twin (`lookupAdminSession`) both require `authenticated = true`. The merchant side lost it when it moved to the view.
- **Breaks:** Anyone with a merchant password gets a full dashboard session and never needs the second factor. That makes 2FA meaningless.
- **Fix:** Add `AND s.authenticated = true`. New test `auth/sessions.pending.test.ts`.

### 🔴 S-2 OTP codes and payment-link tokens come from `Math.random()`
- **Where:** `apps/api/src/lib/random.ts` (used by `auth/otp.ts` and `paymentLinks/create.ts`)
- **Why:** V8's `Math.random` is xorshift128+. A few observed outputs (for example your own link tokens) let an attacker recover the state and predict the next codes and tokens. ARCHITECTURE says link tokens are 128-bit from `crypto.randomBytes`. The admin OTP already uses `crypto.randomInt`; the merchant one regressed ("the OTP implementation changed at some point").
- **Breaks:** Predictable login OTPs. Predictable payment-link URLs, which are the only credential for `GET`/`POST /v1/payment-links/:token`.
- **Fix:** `crypto.randomInt` in `randomDigits` and `randomFromAlphabet`.

### 🟠 S-3 OTP brute force through parallel requests (merchant and admin)
- **Where:** `routes/auth.ts` and `routes/adminAuth.ts` `/otp/verify`
- **Why:** The code reads `attempt_count`, compares, then increments only on a miss. N concurrent requests all read `attempt_count = 0`, so the 5-guess limit becomes "5 guesses per burst". The admin comment says the row is "read FOR UPDATE"; it isn't.
- **Fix:** Reserve the attempt atomically (`UPDATE … SET attempt_count = attempt_count + 1 WHERE attempt_count < max_attempts AND consumed_at IS NULL RETURNING`) before comparing. Consume with `WHERE consumed_at IS NULL`.

### 🟠 S-4 OTP session bound to the wrong merchant user
- **Where:** `routes/auth.ts` login uses `findOtpRecipient(email) ?? user`
- **Why:** `findOtpRecipient` looks the email up across **all** merchants with `LIMIT 1` and no ORDER BY. The same email is allowed under several merchants (one row per merchant_id + email).
- **Breaks:** Logging in to merchant A can produce a pending session for merchant B's user row, so after OTP you are inside the wrong merchant, possibly with a different role.
- **Fix:** Use the user that just passed the password check.

### 🟠 S-5 Merchant A can cancel merchant B's payment link
- **Where:** `paymentLinks/cancel.ts`
- **Why:** The route checks that the `:merchantId` in the path is the caller's own, but the `UPDATE … WHERE id = $1` never checks that the link belongs to that merchant.
- **Fix:** Pass `merchantId` through and add `AND merchant_id = $2` to both queries.

### 🟠 S-6 FP-187: expired payment link still payable
- **Where:** `paymentLinks/pay.ts` `expiryReferenceTime(input.submittedAt)`
- **Why:** The expiry check uses the `submittedAt` the checkout page sends. The buyer controls that field, so back-dating it makes any expired link payable.
- **Fix:** Expiry is always judged on the server clock.

### 🟠 S-7 Acquirer callbacks accepted unsigned, replayable and duplicated (FP-201)
- **Where:** `config.ts`, `webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`, `acquirer/callbacks.ts`
- **Why:**
  - (a) `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults to `false` and a missing header returns `valid: true`. The signature is this public endpoint's *only* authentication.
  - (b) There is no timestamp freshness check, so a captured callback replays forever.
  - (c) There is no uniqueness on `callback_id`. The "processed_events" table and FP-238 index that the 0051 comment and the 1.9.0 postmortem cite were never created, and `withCallbackRetry` re-runs the insert too.
  - (d) `outcome` is never validated.
- **Breaks:** Anyone can write fraud verdicts onto any transaction's timeline, and the acquirer's retries create duplicate notes (FP-201 reopened).
- **Fix:**
  - Require the signature by default.
  - Add a 300 s tolerance.
  - Validate `outcome`.
  - Migration `0074` dedupes existing rows and adds a unique index on `callback_id`, with `ON CONFLICT DO NOTHING` on insert.
- ⚠️ **Possible new bug (for review):** to create the unique index, `0074` *deletes* existing duplicate rows, keeping the first of each `callback_id`. `acquirer_callback_notes` is meant to be append-only. If any duplicates were genuinely distinct callbacks that reused an id, their notes are lost. A safer variant copies them to an archive table first.
- **Not fixed:** The HMAC is still computed over `JSON.stringify(parsed body)` instead of the raw bytes, so any reformatting by the acquirer breaks verification. Fixing that needs Fastify raw-body support.

### 🟠 S-8 FP-240: merchants can't verify webhook signatures
- **Where:** `webhooks/dispatcher.ts`, `webhooks/testSend.ts`
- **Why:** `signPayload` HMACs `canonicalJson(payload)` (sorted keys), but the request body is `JSON.stringify(payload)`. That uses insertion order, and the payload comes back from a JSONB column, which re-orders keys. The bytes signed are not the bytes sent. This is what Yousif's unmerged `ya/sign-raw` branch was for.
- **Fix:** Send `canonicalJson(payload)`, the exact signed bytes.

### 🟠 S-9 Impersonation grants write access; disabled admins keep it
- **Where:** `admin/impersonation.ts`
- **Why:**
  - The role map gives `finance → finance` and `super_admin → owner`. HANDOVER and the route doc say impersonation is always read-only `support`.
  - Writes made while impersonating are recorded as `merchant_session` (`requireMerchantWriterActor`), so the audit trail shows the merchant did it.
  - `lookupImpersonationGrant` never checks `admin_users.status`. The "admin-disable trigger" mentioned in the comments does not exist.
- **Fix:** Map every admin role to `support`, and add `AND au.status = 'active'`.

### 🟡 S-10 API key "rotation" never retires the old key
- **Where:** `admin/apiKeys.ts`, `apiKeys/verify.ts`
- **Why:** Rotation issues a new key but leaves the old one valid forever. `revoke_after` (0056) is never set or read, and no sweep job exists.
- **Breaks:** Rotating a leaked key does not stop the leak.
- **Fix:** Keep the intended overlap window but end it: set `revoke_after = now() + 24h`, and `verifyApiKey` rejects keys past `revoke_after`.

### 🟡 S-11 Credits two-person control compares display names
- **Where:** `admin/creditApproval.ts`
- **Why:** `approver.displayName === requester.displayName`. Two different admins with the same name can't approve each other. Worse, the check isn't tied to identity at all (HANDOVER: "compared by admin user id").
- **Fix:** Compare `adminUserId`.

### 🟡 S-12 A merchant can read any split child's reports
- **Where:** `apps/api/src/reporting/scope.ts`
- **Why:** The scope check only asks "is this merchant a split child of *anyone*", not "of the caller".
- **Fix:** Add `AND parent_merchant_id = $2`.

### 🟠 S-14 Payment link charged twice (incident 2026-05-14)
- **Where:** `apps/api/src/paymentLinks/pay.ts`
- **Why:** The claim releases its row lock immediately, and a reservation older than 60 s can be re-claimed. If buyer A's authorize/capture is slow, buyer B re-claims and pays. A then captures too, and finalize matches 0 rows. The "unreachable" branch logs and still returns 200, so both cards are charged.
- **Fix:** Each claim gets its own `reservation_id` (migration `0075`). After authorize and before capture, the attempt re-checks (and refreshes) that the reservation is still its own. If it was taken, it voids its authorization (no money moved) and returns 409. Release and finalize are keyed on the reservation id too.
- **Limit:** A capture call that itself takes more than 60 s after the re-check could still race. A row lock held for the whole pay would close it, at the cost of pool connections.

### 🟠 S-15 Any admin could issue credits
- **Where:** `apps/api/src/routes/adminCredits.ts`
- **Why:** `POST /merchants/:id/credits` only required an admin session. `createCreditRequest`'s own contract says finance and super_admin, support gets 403. Credits under the threshold post to the ledger immediately, so a support login could move up to 50 BD per call with no second approver.
- **Fix:** `requireAdminRole("finance", "super_admin")` on the route. ADMIN.md says support may issue small credits; the code contract was followed.

### 🟡 S-13 Admin bulk KYC approve ignores status
- **Where:** `admin/bulkKyc.ts`
- **Why:** It approves every id sent, including rejected merchants. ADMIN.md says only `under_review` ones are affected.
- **Fix:** Add `AND onboarding_status = 'under_review'`.

---

## 2. Money

### 🔴 M-1 Scheme statement always a few fils *over*, never under
- **Where:** `apps/settlement/internal/settlement/batch.go` CloseBatch, `SchemeAmountBD(line.grossFils)`
- **Why:**
  - `amount_fils` is the truncated value (4747 → 4740), but the `amount` column is filled from the **untruncated** gross: `4.747` written into `NUMERIC(10,2)`, which Postgres rounds half-up to `4.75`.
  - The scheme file prints `amount`, so every line with a third digit of 5–9 sends 10 fils more than our ledger. Lines with 0–4 match, so the gap is only ever upward.
  - ADR-0002: "the scheme file amount must be exactly `amount_fils / 1000`".
- **Fix:** Pass the truncated value.

### 🟠 M-2 Scheme residue never journaled (ADR-0002 says it is)
- **Where:** `batch.go` CloseBatch
- **Why:** ADR-0002 is marked "implemented in CloseBatch (2026-03)". HANDOVER says "nothing posts residue yet", and the code agrees with HANDOVER. The ledger, the settlement report and the scheme statement cannot tie.
- **Fix:** Per line, post the ADR's balanced group: `card_scheme_clearing` credit and `scheme_rounding_residue` debit for `gross − truncated`.

### 🔴 M-3 CSV import 10× too small, and drops the third decimal
- **Where:** `apps/api/src/admin/adjustmentCsvParsing.ts` → `lib/decimal.parseDecimalMinor(raw, 2)`
- **Why:** It parses BD text as **2-decimal cents**: `"4.75"` → 475 fils (0.475 BD) and `"4.755"` → `"475"` + `"5"` truncated → 475. ADR-0001 rule 3 requires `parseBhdToFils`. The tests asserted 475; Yousif flagged it in 9567ea0.
- **Fix:** `parseBhdToFils(raw)`. Test expectations corrected to 4750, 1250, 6000, 3500, 5000.

### 🟠 M-4 Delta Marketplace split payouts a few fils short every batch
- **Where:** `apps/settlement/internal/splits/allocate.go`, `shares.go`
- **Why:** Each child's share is `ApplyRateFils(net, weightBps)`, rounded on its own, so the shares don't sum to `net_payout_fils`. The parent's ledger and cache are reduced by the sum of shares, not the net. The missing fils stay on the parent and appear in no child's record ("can't find them anywhere"). FP-250 was closed without a fix.
- **Fix:** Largest-remainder allocation (`money.AllocateByWeights`, a Go port of `allocateRemainder`). Shares always sum to the net. Test `money/allocate_test.go`.

### 🟠 M-5 Net payout computed through `float32`
- **Where:** `settlement/payable.go` `NetPayableFils`
- **Why:** `float32` has a 24-bit mantissa, so any batch above about 16,777 BD loses whole fils. ADR-0001 makes float on money a review blocker.
- **Fix:** `gross - fee`. Test `money_precision_test.go`.

### 🟠 M-6 MDR recalculation rewrites paid-out batches
- **Where:** `settlement/recalculate_mdr.go`
- **Why:** It selects `status <> 'open'`, which includes `paid`, then UPDATEs `fee_fils` and `net_payout_fils` on those batches and moves the balance cache. A paid batch's figures are what actually left the platform.
- **Fix:** Only `status = 'closed'` (not yet paid).

### 🟠 M-7 "Recalculate cached balances" button: Alpha Retail 135K → 7K (FP-203)
- **Where:** `apps/settlement/internal/internalapi/server.go` → `ledger.RefreshBalanceCache`
- **Why:** The button rebuilds from the `merchant_payable_position` view, which is the sum of **gross scheme-export amounts for all batches ever**. It never subtracts fees or payouts and ignores the ledger. The CLI walks `ledger_entries` (`RebuildAllBalances`). HANDOVER: "there shouldn't be a button that reads anything else".
- **Fix:** The handler calls `RebuildAllBalances`, same as the CLI.
- **ADR-0004 is flawed (kept, reported):** it approves the "faster path" on the premise that it "reflects what actually left the platform". The view it reads (gross scheme exports, never net of fees or payouts) does not, so its consequence "the two paths agree whenever the cache is consistent" can never hold. The ADR should be superseded. The ledger walk may need a longer HTTP timeout (~40 s cold).

### 🟡 M-8 Fee in the dashboard (245 bps) ≠ fee charged (225 bps)
- **Where:** `apps/api/src/fees/currentFeeScheduleDisplay.ts`
- **Why:** The display picks the newest row **by `created_at`**. Capture and settlement pick by `effective_from <= now()`. A backdated correction entered later (245 bps for March, entered in August) shows as "current" while 225 bps is charged.
- **Fix:** Use the same resolution as capture. Test updated to the case-file scenario.

### 🟡 M-9 Settlement summary over-counts multi-part captures (and is slow)
- **Where:** `apps/api/src/settlement/query.ts` `getSettlementSummary`
- **Why:** It joins one row per capture event but sums `transactions.captured_fils`, the running total. A transaction captured in three parts counts its full total three times. That is why Delta's summary exceeded the batches in the July perf note.
- **Fix:** Sum `te.amount_fils`.
- **Not fixed:** The slowness itself, a seq scan on `transaction_events`, which needs an index on `(transaction_id, occurred_at)`.

### 🟠 M-13 Unapproved platform-wide fee discount (−15 bps for every merchant)
- **Where:** `apps/api/src/payments/capture.ts`, `apps/settlement/internal/settlement/batch.go`
- **Why:** HANDOVER: Huda (finance) floated a platform volume discount and Yousif said "no until finance signs off in writing". The code says "approved by finance — am", but MK's note says there's no ticket and Huda didn't know about it. Once platform volume passes 2,000,000 BD, every merchant's MDR drops 15 bps at capture and settlement: lost platform revenue, never approved.
- **Fix:** The discount is no longer applied in either place. The volume counter is still recorded, so it can be re-enabled if finance signs off.

### 🟡 M-10 Platform volume counter overflows at the tier threshold
- **Where:** `platform_stats.total_processed_fils INTEGER` and Go `int32`
- **Why:** INT max is 2,147,483,647 and the tier threshold is 2,000,000,000. After crossing it, the next batches overflow: an error in Postgres, and silent wraparound in Go.
- **Fix:** Migration `0073` → BIGINT, and `int64` in Go.

### 🟡 M-11 Lifetime payout estimate drifts for high-volume merchants
- **Where:** `payout_estimate.go`, column `REAL`
- **Why:** `float32` parameter plus a `REAL` column: about 7 significant digits, so increments vanish once the total is large.
- **Fix:** `int64`, and migration `0073` makes the column BIGINT.

### 🟡 M-12 Duplicate payout disbursements
- **Where:** `apps/api/src/webhooks/payoutDisbursement.ts` (pre-delivery effect)
- **Why:** It runs once per delivery row with `attempt_count = 0`: once per merchant endpoint, and again on every admin replay. That creates one disbursement record each time. This matches "two disbursement records each" in the 2026-08-21 review.
- **Fix:** Insert only if none exists for the batch, under an advisory lock.

---

## 3. Settlement and scheduling

### 🟠 T-1 Daily close runs at 03:00 Bahrain, not midnight
- **Where:** `apps/settlement/internal/scheduler/daemon.go` `runIfDue`
- **Why:** `now := time.Now().UTC()` is passed to `BusinessDayWindow`, which takes the **calendar date of the argument's own zone**. Between 00:00 and 03:00 Bahrain the UTC date is still yesterday, so "today's Bahrain midnight" is computed one day early and nothing new is due until UTC midnight, which is 03:00 Bahrain. The ops log shows "~03:15 local".
- **Fix:** Take `now` in Asia/Bahrain (`settlement.InBusinessDayLocation`).

### 🟠 T-2 Duplicate "your payout is on the way" (incident 2026-08-21)
- **Where:** `settlement/payout_notify.go`
- **Why:** NOT-EXISTS-then-INSERT with no lock, so the daemon and the CLI both pass the check and both insert. The comment claims a unique index on `outbox_events (event_type, aggregate_id)`; none exists.
- **Fix:** Run the scan in a transaction under `pg_advisory_xact_lock`.

### 🔴 T-3 Test merchants appear in the real settlement run
- **Where:** `apps/api/src/routes/adminMerchantsRecompute.ts` → `admin/merchantFlags.reconcileSandboxFlag`
- **Why:** "Recompute transaction statuses" (finance tool) also silently sets `test_mode = false` on any merchant with no open authorizations. Settlement only excludes `test_mode = true`, so the next daily batch settles test merchants for real ("what happens to test merchants when certain admin tools run?").
- **Fix:** The recompute no longer touches `test_mode`.

---

## 4. Scripts

### 🔴 X-1 `expire_holds.ts` can delete **every** hold
- **Where:** `scripts/expire_holds.ts` and `scripts/lib/sqlFilter.ts`
- **Why:** With no expired holds the id list is empty, and `buildWhere` skips empty arrays, so the query becomes `DELETE FROM holds` with no WHERE. HANDOVER also says holds are flipped to `expired` and never deleted. The SELECT-then-DELETE also races with captures.
- **Fix:** A single `UPDATE holds SET status='expired' WHERE status='active' AND expires_at < now()`, and `buildDelete` refuses an unfiltered DELETE.

### 🟠 X-2 March sweep script doubles the gap when re-run
- **Where:** `scripts/reconcile_march.ts`
- **Why:**
  - There is no idempotency marker, so every run posts the residue again (staging ran twice and the gap doubled). The log's single timestamp can't prove how many prod runs happened; the ledger can, because rows carry the sweep description.
  - It also posts `merchant_payable` debit / residue credit, which **takes the residue from merchants**. ADR-0002's legs are residue debit / scheme clearing credit.
- **Fix:**
  - An advisory lock plus a refusal if the sweep description already exists in the ledger.
  - ADR-0002 legs.
- **Check before re-running:** Count the rows with that description on prod first.
- **Flag:** It still uses a UTC month (ADR-0003 allows this; HANDOVER disagrees).

---

## 5. Reliability and build

### 🟠 B-1 Fresh database can't be migrated
- **Where:** `db/migrations/0054_views.sql` and `0055_chart_of_accounts_suspense.sql`
- **Why:**
  - 0054 references `settlement_batch_events`, a table that does not exist. 0055 uses columns `code`, `account_type` and `description`, which `chart_of_accounts` does not have.
  - `docker compose run migrate` stops at 0054, so the API (needs `live_sessions` from 0058) and the settlement worker never start.
  - ADR-0005 also reserved 0054–0056 for v2.
- **Fix:** The view uses `te.settlement_batch_id IS NULL`, and 0055 inserts `(id, name, kind)`.

### 🟡 B-2 API won't boot in dev
- **Where:** `apps/api/src/config.ts` `DEV_FALLBACK_WEBHOOK_KEY_B64`
- **Why:** The fallback key decodes to 34 bytes and the loader requires 32, so `loadConfig` throws whenever the env var is unset in dev or test.
- **Fix:** A 32-byte dev key.

### 🟡 B-3 Reporting consumer crashes on a batch for a day it hasn't rolled up yet
- **Where:** `apps/reporting/src/consumer/applyEvent.ts`
- **Why:** `rollupResult.rows[0].captured_count` is read when no row exists, which throws a TypeError. The pass rolls back and the consumer is stuck on that event forever.
- **Fix:** Null-safe; treat a missing row as 0.

---

## 6. Found, not fixed (decision needed or out of scope)

| # | Where | Issue |
|---|---|---|
| N-2 *(teammate's refund feature, not touched)* | `payments/processRefund.ts`, `refunds/initiateMerchantRefund.ts` | **Refunds (FP-212, the teammate's feature):** `refundable = authorized − refunded` instead of **captured** − refunded, so you can refund more than was charged. There is no row lock across the acquirer call, so concurrent refunds both succeed (FP-209); capture holds a `FOR UPDATE` lock, refund doesn't. `initiateMerchantRefund` uses the *transaction's* merchant_id instead of the caller's (IDOR). `reason` NULL violates `chk_refunds_reason_not_null` (0070), so every refund fails. |
| N-3 | `db/migrations/0072` | `refund_merchant_summary` joins `t.id = r.id`, which should be `r.transaction_id`, and double-sums `captured_fils`. |
| N-6 | `payments/capture.ts` vs `discounted_fee.go` | The capture-time fee ignores `negotiated_discount_bps`. The discount is added later only on the `/v1/transactions` route, never for payment-link captures, while settlement applies it to the amount. The ledger fee and the batch fee disagree. |
| N-7 | `settlement/query.ts` reconciliation | Uses `merchants.mdr_bps` (the "0046 sync trigger" doesn't exist) and float `estimateFeeFils`. |
| N-8 | `apps/reporting` cursor | Outbox read by `id > cursor`. Ids are assigned at insert, not commit, so a slower transaction's lower id gets skipped forever. |
| N-9 | `ADR-0006` / `balanceAdjustments.ts` | "Adjust balance" writes only the cache. The next rebuild wipes it, and ADMIN.md tells support it is journaled. |
| N-10 | `webhooks/archiveReplay.ts` | Archive loads the whole range into one JSON row (ADMIN.md says "pages of 1000"). A large range can OOM a 512 MB API. |
| N-11 | `ops/.env.docker` | Committed to git with `ACQUIRER_CALLBACK_SIGNING_SECRET`. `.gitignore` only matches `.env`. Rotate it and ignore `.env.*`. |
| N-12 | `transactions/exportCsv.ts` | The streaming export pages on `occurred_at >` only, so rows sharing the boundary timestamp are skipped. Cells are not neutralised against CSV formula injection. |
| N-13 | `internalapi/server.go` | Binds all interfaces; `SETTLEMENT_INTERNAL_TOKEN` defaults to `dev-token`. |
| N-14 | `admin/adjustmentImport.ts` | No duplicate detection. Huda's double-click imported the August file twice (finance Slack, 2026-09-04), and both postings are in the ledger. |
| N-15 | `migrations/0074` | Deletes duplicate callback notes so it can add the unique index (see S-7). Possible data loss if any duplicates were distinct callbacks. |

---

## 7. `CLAUDE.md` is wrong (and steers an AI assistant into the bugs)

| `CLAUDE.md` says | Reality |
|---|---|
| Money is "integer **cents** (1 BD = 100)" | ADR-0001 says 1 BD = 1000 fils. This is the root of the CSV 10× bug. |
| `parseBhdToFils` "normalises 4.75 and 4.750" | True, but the CSV path didn't use it. |
| Settlement windows use **UTC** midnight | ARCHITECTURE and the case file say Asia/Bahrain midnight (T-1). |
| Go service is the fee reference | The ADRs and docs are the reference; the Go service had float32 and rounding bugs. |
| `packages/money` frozen, "probably intentional" | No change was needed there; the bugs are all in callers. |
| "Never modify existing test files" | Several tests locked in bugs (CSV 475, fee display 245, unsigned callbacks). They were corrected. |
| `Math.random()` fine for OTP and link slugs | Both are bearer secrets (S-2). |
| Impersonation handler needn't re-check | Role mapping and disabled-admin checks were wrong (S-9). |
| `float32` for display BD amounts | Used on payout paths (M-5, M-11). |
| "Docs canonical, code has the bug" | Mostly right, but ADR-0004 and ADR-0006 themselves describe unsafe designs. |

---

## Tests

- Go `go test ./...`: all pass, including the DB-backed tests against a migrated Postgres 16.
- TS `npm test`: every failure that remains was already failing before these changes:
  - 11 refund tests: N-2, the `reason` constraint (feature work).
  - 1 dispatcher backoff test: it asserts an exact value through ±10 % random jitter, so it is flaky.
  - 4 reporting tests: the API test suite leaves outbox rows with `{}` payloads in the shared database.
- Updated test files: `adjustmentImport.test.ts`, `adminAdjustmentImport.test.ts`, `currentFeeScheduleDisplay.test.ts`, `acquirerCallbacks.test.ts`.
- New test files: `auth/sessions.pending.test.ts`, `money/allocate_test.go`, `settlement/money_precision_test.go`.
