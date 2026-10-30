# Hackathon bug tracker

Latest review: [2026-10-30 fork review](docs/reviews/2026-10-30-fork-review.md), based on `0b3d3c3`. New fixes below were tested with injected dependencies, not a live database.

Status: 🔴 open · 🟡 in progress · ✅ fixed · ❓ lead (unverified) · ➖ not a bug

Confidence tags (Evidence column): **[verified live]** reproduced against the running app/DB or by executing the code · **[code-confirmed]** traced in the code against the spec, not yet reproduced · **[failing test]** a test fails, root cause not yet known. Anything weaker stays ❓. Red herrings that turned out fine are marked ➖ rather than deleted.

Plain-language version for non-technical readers: [BUGS-EXPLAINED.md](BUGS-EXPLAINED.md).
Keep both files in sync (same bug numbers).

> The repo's CLAUDE.md, AGENTS.md and .cursorrules contradict ARCHITECTURE.md
> and the ADRs (cents vs fils, UTC vs Bahrain, "never touch tests"). They are
> part of the puzzle. ARCHITECTURE.md, ADR-0001 and HANDOVER.md are the spec.

## Money

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | ✅ | Adjustment CSV import parses BD with 2 decimals → "4.75" becomes 475 fils (10× too small) | `apps/api/src/admin/adjustmentCsvParsing.ts:8` (`parseDecimalMinor` default `decimals=2`) | **[verified live]** Huda sheet 4,141.90 BD vs 414.190 posted; March gap ≈ 4.75 BD; commit 9567ea0 | Use `parseBhdToFils`; rejects >3dp. Tests corrected (475→4750 etc.) |
| 2 | ❓ | No guard against importing the same adjustment file twice — a **missing feature** (FH's TODO), not broken code | `apps/api/src/routes/adminAdjustmentImport.ts` | Aug file imported twice (Slack 09-04) | |
| 3 | ✅ | Scheme file amount is rounded, not truncated: CloseBatch stored the untruncated gross (`SchemeAmountBD`, a float) into `NUMERIC(10,2)`, which rounds; the file is built from that column → lines overstated by up to 9 fils, never understated | `apps/settlement/internal/settlement/batch.go:255`, `scheme_export.go:29` | **[verified live]** 7 of 1,395 local lines mismatched, all 7 higher (e.g. 4,740 fils → 4.75, 8,070 → 8.08), +70 fils total — memo's "always over, never under" | Store `SchemeAmountText(gross)` = exact 2dp string of the **truncated** fils (no float); migration 0073 adds `CHECK (amount*1000 = amount_fils) NOT VALID` (new rows only — historical rows kept as the record of what was sent); new `scheme_amount_truncate_test.go`. Go suite all ok; 21 new lines written post-fix, 0 mismatched |
| 4 | ✅ | `float32` on money: `NetPayableFils` (used by CloseBatch for the bank payout) loses precision — gross 20,000.123 / fee 560.003 BD pays 1 fils short | `apps/settlement/internal/settlement/payable.go:11`, `batch.go:219`; also `payout_estimate.go` | **[verified live]** commit 925744c; ADR-0001 "float is a review blocker" | `NetPayableFils` = integer `gross - fee`; lifetime estimate passes int64; `EstimateMonthlyPayout` returns `money.Fils`; migration 0074 converts `lifetime_net_payout_monitoring_estimate` REAL → BIGINT and recomputes from paid batches; new `payable_integer_test.go` |
| 5 | ✅ | Refund fee reversal rounded each partial separately (fee 3 on 120 refunded 60+60 reversed 4); also summed only fee credits, ignoring discount rebates (YA's warning) | `calculateRefundFee` | **[verified live]** test reproduces 4 on old code | Fee reversal prorated on the running total of succeeded refunds against the **net** fee kept (capture fee − discount rebates, excluding prior reversals), minus fees already reversed — never exceeds the fee charged. Test: 120 fils/3 fils fee refunded 60+60 → reverses 3, not 4 |
| 6 | ✅ | Recalculate MDR selects `status <> 'open'` (includes **paid**) and UPDATEs `fee_fils`/`net_payout_fils` on paid batches, rewriting history | `apps/settlement/internal/settlement/recalculate_mdr.go:67,109` | **[code-confirmed]** Finance memo; its own comment says paid figures stay | Skip the `UPDATE settlement_batches` when `status = 'paid'`; adjustment ledger group still posted. New `recalculate_mdr_paid_test.go` |
| 7 | ❓ | Settlement summary double-counts multi-capture merchants (+38% vs batch gross) | `/v1/settlement/summary` query | docs/perf/2026-07-settlement-summary-slow.md | |
| 35 | ✅ | Promotional discount parsed with `parseFloat(raw) * 100` (10× small, float on money, accepts "4.75abc") | `apps/api/src/payments/discountAdjustment.ts:12` | **[code-confirmed]** same pattern as #1 | Use `parseBhdToFils`; new `discountAdjustment.parse.new.test.ts` |
| 8 | ❓ | `calculateFee` half-up vs half-to-even (ADR-0001 says half-to-even) | `apps/api/src/v1/fees/calculateFee.ts:16` | "Claude says" comment | |

## Payments / links / callbacks

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 9 | 🔴 | Payment link re-claimable after 60 s reservation timeout → double payment | `apps/api/src/paymentLinks/pay.ts:66-75,152` | **[code-confirmed]** Every double had first attempt > 60 s; AM postmortem note | |
| 10 | 🔴 | No constraint "one successful capture per link" (FP-202 marked done, never merged) | migrations / pay.ts | **[code-confirmed]** postmortem action #2 | |
| 11 | 🔴 | Acquirer callbacks not deduplicated (no `processed_events`) | `apps/api/src/acquirer/callbacks.ts` | **[code-confirmed]** commit bf66bf2 "They are not"; no migration; support ticket FP-201 (reopened): two identical notes saved for one callback | |
| 12 | ❓ | Holds flip back to `active` after void | `apps/api/src/payments/void.ts`, `scripts/expire_holds.ts` | Slack 05-14 | |
| 13 | ❓ | Idempotency: same key + same body on a different transaction should 422 | `apps/api/src/payments/idempotency.ts` | `transactions.test.ts:218` | |

## Webhooks

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 14 | ✅ | Signature computed by `signPayload(row.payload)` but body sent is a separate `JSON.stringify(row.payload)` — sign the exact bytes sent | `apps/api/src/webhooks/dispatcher.ts:158,172` | **[code-confirmed]** lost branch `ya/sign-raw`; Beta signature complaint | Both dispatcher and send-test serialize the canonical body once, sign that exact string, and send it unchanged. Independent receiver-HMAC regression checks cover both paths; see fork review. |

## Balances / ledger

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 15 | ✅ | Console "Rebuild cached balances" (only caller of `ledger.RefreshBalanceCache`) sets payable = SUM of all-time scheme export **gross** via view `merchant_payable_position` — no fees, payouts, refunds, credits or adjustments; split parents with no scheme lines get 0. CLI `rebuild-balances` walks `ledger_entries` correctly. View lives in migration 0054, reserved for v2 by ADR-0005. ADR-0004, MK's Slack ("same thing") and CHANGELOG 1.7.0 all claim button = CLI; support's "Adjust balance" (ADR-0006) masked it | `internalapi/server.go:266` → `ledger/refresh.go`; `db/migrations/0054_views.sql` | **[verified live]** **Reproduced 2026-10-30**: CLI moved Alpha 7,326.770 → 136,496.486 BD (memo's "135K → 7K"); Delta Marketplace 0 → 22,677.280; Beta −89.772, Gamma −196.449, Delta Wholesale −25,644.136 BD (button overstates gross) | Internal API `/internal/rebuild-balances` now calls `ledger.RebuildAllBalances` (same as CLI); `server_test.go` corrected (it asserted the scheme-export total) and given a fee leg so ledger 11,700 ≠ export 12,000. **Live:** button leaves Alpha at 136,496.486 BD (`changed: false`) |
| 16 | ❓ | "Adjust balance" edits cache without ledger entry, masks drift | `apps/api/src/admin/balanceAdjustments.ts` | ADR-0006, FP-203 | |
| 17 | ✅ | "Recompute transaction statuses" silently sets `test_mode = false` when no open auths → test merchants (Gamma) enter real settlement | `apps/api/src/admin/merchantFlags.ts:10-17` | **[code-confirmed]** Memo; Slack 09-19 `testModeCleared: true` | Recompute route no longer calls `reconcileSandboxFlag` (deleted `admin/merchantFlags.ts`, staged with git rm); response keeps `flagsUpdated: []`; new `adminMerchantsRecompute.new.test.ts` logs in as finance and proves test_mode stays true |

## Time windows

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 18 | ➖ | (Not a bug — `todayBahrainDateString` is correct; red herring) Analytics off by one between 21:00–24:00 UTC (should use Bahrain day) | `apps/api/src/routes/analytics.ts:39` | "Claude says" | |
| 19 | ✅ | March sweep: (a) not idempotent — random `entry_group_id` per run (comment "dedupes" is false), no dry-run mode; (b) UTC month window; (c) debits `merchant_payable` instead of ADR-0002 legs (credit `card_scheme_clearing` / debit `scheme_rounding_residue`) — charges merchants the residue | `scripts/reconcile_march.ts:16,58-66` | **[code-confirmed]** Memo: ran twice on staging, gap doubled | Bahrain-month `monthBounds`; dry run by default, `--apply` to post; advisory lock + refuses if rows with its description exist; posts ADR-0002 legs (credit `card_scheme_clearing` / debit `scheme_rounding_residue`) dated end of Bahrain March; test corrected; RUNBOOK updated. **Live:** apply #1 posted 5.020 BD (42 rows), apply #2 → "already posted… Nothing done" |
| 20 | ✅ | Daemon passes UTC `now` to `BusinessDayWindow`, which uses its Y/M/D, so "today" is the UTC date → daily close runs ~03:15 Bahrain instead of 00:15 | `apps/settlement/internal/scheduler/daemon.go:80` | **[code-confirmed]** HANDOVER; AM comment "close ~03:15 local not 00:15" | New `dueBusinessDate` converts now to Asia/Bahrain before `BusinessDayWindow`; `settlement.BusinessDayLocation()` exported; new `due_business_date_test.go` (00:20 Bahrain → due) |

## Security / auth

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 21 | ✅ | `Math.random()` for OTP codes (merchant + admin), payment link tokens and admin invite codes (spec: `crypto`, 128-bit). Admin OTP comment falsely says `crypto.randomInt` | `apps/api/src/lib/random.ts`, `auth/otp.ts:8`, `paymentLinks/create.ts:12`, `admin/inviteCode.ts:10` | **[code-confirmed]** ARCHITECTURE §Security | `lib/random.ts` and `inviteCode.ts` use `crypto.randomInt`; new `random.new.test.ts` pins Math.random to prove independence |
| 22 | ✅ | Impersonation maps super_admin→merchant `owner`, finance→`finance` (spec: always `support`, read-only). Grant lookup doesn't check admin is still active; the "admin-disable trigger" FH cites doesn't exist | `apps/api/src/admin/impersonation.ts:86-90,113` | **[code-confirmed]** HANDOVER; ARCH §8 | All admin roles map to merchant `support`; grant lookup requires `au.status = 'active'`; new `impersonation.new.test.ts` |
| 23 | ❓ | 403 instead of 404 for another merchant's resource | `apps/api/src/routes/apiKeys.ts:18` | ARCHITECTURE: 404 everywhere | |
| 24 | ➖ | (Not a bug — admin re-set just refreshes TTL; admin lookup checks `authenticated`) Admin cookie set twice | `apps/api/src/routes/adminAuth.ts:179` | | |
| 25 | ✅ | Credit self-approval check compares **display name**, not admin user id (confirmed vs HANDOVER). Threshold ignoring fee reversal is only supported by an FH comment, not the spec — treat that half as a lead | `apps/api/src/admin/creditApproval.ts:9`, `creditThreshold.ts` | **[code-confirmed]** HANDOVER; FH comment `credits.ts:226` | Compare immutable adminUserId, not displayName. Regression cases reject same ID/changed name and accept distinct IDs/same name. Principal-only threshold follows ADMIN.md and is unchanged. |
| 26 | 🔴 | `ops/.env.docker` committed with acquirer signing secret (`.gitignore` `.env` doesn't match it) | `ops/.env.docker` | **[code-confirmed]** `git ls-files` | |

## Infra / reliability

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 27 | 🔴 | ROLLBACK error masks original error | `apps/api/src/db/withTransaction.ts:11` | **[code-confirmed]** "Claude says" | |
| 28 | 🔴 | Built-in dev `WEBHOOK_SECRET_ENCRYPTION_KEY` decodes to 34 bytes → API won't boot without an explicit key | `apps/api/src/config.ts:153` | **[verified live]** boot error | |
| 29 | 🔴 | `ops/Dockerfile.node` / `Dockerfile.go` missing → compose can't build services | `ops/` | **[code-confirmed]** AM note in ops/README | |
| 39 | ✅ | **OTP bypass**: merchant `lookupSession` reads `live_sessions`, which doesn't filter `authenticated = true`, so a password-only (pending) session can call every protected endpoint | `apps/api/src/auth/sessions.ts:89`, `db/migrations/0058_live_sessions.sql` | **[verified live]** Verified: GET api-keys → 200 without OTP | Added `AND s.authenticated = true` to `lookupSession`; new test for pending session. Live: password-only → 401, after OTP → 200 |
| 40 | ✅ | **expire_holds deletes ALL holds** when none are expired: empty id list → `buildWhere` drops the filter → `DELETE FROM holds`. Also deletes instead of flipping to `expired`, and SELECT/DELETE race | `scripts/expire_holds.ts`, `scripts/lib/sqlFilter.ts:10` | **[verified live]** Verified: `buildExpiredHoldsDelete([])` → `DELETE FROM holds` | Rewritten as one atomic `UPDATE holds SET status='expired' WHERE status='active' AND expires_at < now()`; `sqlFilter` empty list → `FALSE`, `buildDelete` refuses unfiltered deletes; test rewritten |
| 41 | ❓ | Merchant `lookupSession` doesn't check the merchant user/merchant is still active | `apps/api/src/auth/sessions.ts` | admin lookup checks `au.status` | |
| 42 | ➖ | Reporting tests fail with NULL `merchant_id` — **cause: test pollution, not app code**: `archiveReplay.test.ts` inserts `transaction.captured`/`voided` outbox rows with `{}` payloads into the shared DB, which the reporting consumer then reads | `apps/reporting/src/consumer/applyEvent.ts` | **[verified live]** outbox ids 119/120 have `{}` payloads; local reporting worker stuck on id 119 since 08:58 | |
| 43 | ✅ | Split payouts: each child share rounded separately with `ApplyRateFils`; remainder never allocated, batch still marked paid → fils stranded in parent payable every batch | `apps/settlement/internal/splits/allocate.go`, `shares.go` | **[code-confirmed]** Memo: children don't sum to parent | `ChildShares` gives the rounding remainder to the largest-weight child so shares sum to net exactly; `PayoutSplitBatch` uses it and refuses weights ≠ 10000 bps; new `shares_remainder_test.go` (e.g. 10,001 → 3333/3333/3335) |
| 44 | ✅ | Dashboard fee display picks newest **created** fee_schedules row (`ORDER BY created_at DESC`); billing uses newest **effective_from ≤ now**. Backfills/backdated rows show wrong rate. Go `LoadFeeSchedules` lacks `created_at` tie-break so same-day corrections can differ from API | `apps/api/src/fees/currentFeeScheduleDisplay.ts`, `apps/settlement/internal/settlement/fee_schedule.go:32` | **[code-confirmed]** Memo: shows 245bps, charges 225bps | Display query now `effective_from <= now() ORDER BY effective_from DESC, created_at DESC` (same as billing); display test corrected (asserted 245) + future-dated case; Go `LoadFeeSchedules` tie-break `created_at ASC` |
| 45 | ✅ | Cross-merchant payment link cancel: route checks path merchant = caller, but `cancelPaymentLink` filters by link id only → A cancels B's link via `/merchants/A/payment-links/<B's id>` | `apps/api/src/paymentLinks/cancel.ts`, `routes/paymentLinks.ts:105` | **[code-confirmed]** Memo | Scope `cancelPaymentLink` by `merchant_id` (UPDATE and lookup); route passes path merchant; new `paymentLinks/cancel.new.test.ts` (other merchant → not_found, link stays active; owner → canceled). 10/10 pass |
| 46 | ✅ | **Over-refund on partial captures**: refundable = `amount_fils` (authorized) − refunded instead of `captured_fils` − refunded → 10 BD auth / 4 BD capture can refund 10 BD | `apps/api/src/payments/processRefund.ts:90` | **[code-confirmed]** Code read; validateRefundRequest trusts the passed `refundableFils` | Refundable = captured − refunded; new `processRefund.fixes.new.test.ts` (fails on old code) |
| 47 | ✅ | Admin API key **rotation never revokes the old key** (AM's "it does, around line 47" is false); `revoke_after` column (0056) is never read and no sweep job exists → rotated keys stay valid forever | `apps/api/src/admin/apiKeys.ts`, `apiKeys/verify.ts:19`, `db/migrations/0056_api_keys_revoke_after.sql` | **[code-confirmed]** Commit 3d9b223 "rotated everything **again**" | Revoke the locked predecessor in the same transaction as replacement issuance and audit. Unit checks cover commit, rollback on audit failure and ownership rejection. No grace period is introduced. |
| 48 | 🔴 | Payment link expiry trusts client `submittedAt` with no bound — anyone can pay an expired link by sending an old timestamp. **Note:** ARCHITECTURE.md documents client-clock expiry for offline terminals, so this is a design risk, not a spec violation | `apps/api/src/paymentLinks/pay.ts:34-38,60` | **[code-confirmed]** Support ticket FP-187: buyer saw "expired" yet was charged; ARCHITECTURE documents client-clock expiry for offline terminals, but the public endpoint applies it to anyone, unbounded | |
| 49 | ❓ | API-key actors bypass `requireMerchantRole` entirely (MK: "by design") — keys can hit owner-only routes; impersonation writes recorded as `merchant_session` (audit can't tell admin from merchant) | `apps/api/src/auth/requireMerchantAuth.ts:128-155` | FH/AM comments | |
| 50 | ✅ | **Concurrent refunds pay out twice**: `processRefund` reads the transaction without `FOR UPDATE`, calls the acquirer, then writes `refunded_fils = <snapshot> + amount`. Two simultaneous refunds (different idempotency keys) both validate against the same snapshot, both hit the acquirer, and the second write overwrites the first. Capture/void lock the row; refunds don't. **Latent**: `POST /v1/refunds` is still a 501 stub | `apps/api/src/payments/processRefund.ts:72-76,200+` | **[code-confirmed]** Support ticket FP-209 | Step 1 locks the row `FOR UPDATE` and reserves `refunded_fils += amount` before the acquirer call; decline/error releases it; journal re-reads under lock. Test: two concurrent 6,000 refunds on 10,000 → one 200, one 422 |
| 51 | ✅ | **Cross-merchant refund**: `initiateMerchantRefund` looks the transaction up by id only and then uses the *transaction's* merchant, so merchant A could refund merchant B's payment (and B's refund hold is checked against A). The "Claude-drafted" route in `routes/refunds.ts` would also mint a fresh idempotency key per request. **Latent** until the route is wired | `apps/api/src/refunds/initiateMerchantRefund.ts:62-75`, `routes/refunds.ts` | **[code-confirmed]** `processRefund.test.ts:466` TODO "Claude says it's covered" — it isn't | `processRefund` and `initiateMerchantRefund` look the transaction up by id **and** caller's merchant; route asserts path merchant = caller. Tests at service and route level |
| 52 | 🔴 | **Duplicate payout notifications**: `EnqueuePayoutNotifications` does NOT-EXISTS-then-INSERT with no lock or unique constraint; the daemon and the CLI both call it, so two concurrent runs both enqueue `settlement.paid`. Postmortem action #7 (`SETTLEMENT_SINGLETON_LOCK` advisory lock, "Done") does not exist in the code | `apps/settlement/internal/settlement/payout_notify.go`, callers `scheduler/daemon.go:102`, `cmd/settlement/main.go:133` | **[code-confirmed]** Incident 2026-08-21; CHANGELOG 1.9.1 told receivers to dedupe instead | |
| 53 | ❓ | OTP resend issues a fresh challenge (fresh attempt budget) every 30 s with no per-session or per-user cap; re-login also unlimited — slow brute force possible | `apps/api/src/routes/auth.ts:199-240` | FH comment `auth/sessions.ts`; support notes "is OTP still safe?" | |
| 55 | ✅ | Reconciliation "pending" re-estimated fees from `merchants.mdr_bps` with float maths, ignoring fee schedules and the volume tier (MK's "0046 trigger keeps it in sync" — no such trigger exists); it also ignored unbatched refunds despite its doc comment | `apps/api/src/settlement/query.ts` | **[verified live]** Alpha today: ledger 5,865 vs pending 5,840 → gap 25 (charged 225 bps, estimated 250) | Pending uses each capture's actual `metadata.feeFils` (estimate only as fallback) and adds unbatched refunds (−amount + fee reversed). Live: gap 0, explained |
| 56 | ✅ | Reporting couldn't record refunds: `merchant_daily_volume` had no refund columns, the half-written rollup listened for `transaction.refunded` (real type `refund.succeeded`) and bucketed by UTC date; admin view `refund_merchant_summary` joined `t.id = r.id` (refund id vs transaction id) so it was always empty, and nothing refreshes it despite its comment | `apps/reporting/src/consumer/applyEvent.ts`, `db/migrations/0072_refund_merchant_summary.sql` | **[code-confirmed]** | Migration 0076 adds columns + recreates the view with the right join (captured counted once per transaction); `refund.succeeded` wired into the consumer, Bahrain date; new `applyEvent.refund.new.test.ts`. View refresh still not scheduled |
| 57 | ❓ | One malformed outbox event stalls the reporting worker forever (it retries the same failing pass; no dead-letter/skip) | `apps/reporting/src/consumer/runConsumerPass.ts` | **[verified live]** stuck on event 119 | |
| 58 | ✅ | Transaction API never returned `refundedFils` (AM's comment "it's there a few lines down" was false), so the dashboard couldn't show what's still refundable | `apps/api/src/transactions/serialize.ts`, `apps/web/src/types.ts` | **[code-confirmed]** | Added to row, DTO and web type; shown on the detail page |
| 38 | 🟡 | API registers no CORS handler, so web/admin can't call it cross-origin (MK comment in `apps/web/src/api/client.ts:37` claims "CORS is locked to the two origins in config" — false) | `apps/api/src/app.ts` | **[verified live]** OPTIONS → 404 | Dev workaround: Vite proxy `/v1` → :3000 in both vite configs |
| 30 | ❓ | Reporting worker leaks LISTEN connections (#398) | `apps/reporting/src/consumer/listener.ts` | FP-209 load test | |
| 31 | ❓ | Missing unique index `(merchant_id, effective_from)` on fee schedules | `apps/api/src/fees/feeSchedule.ts:16` | "Claude says" | |
| 32 | ❓ | `POST /v1/refunds` returns 501 — route not wired | `apps/api/src/routes/refunds.ts` | HANDOVER | |
| 33 | 🔴 | CSV export route uses `buildTransactionsExportCsv` (whole result in memory), not the streaming variant the CHANGELOG claims | `apps/api/src/routes/transactions.ts:161` | **[code-confirmed]** CHANGELOG 1.8.0 "streams rows"; 09-15 API restarts | |
| 36 | ✅ | Refunds fail: `processRefund` inserts explicit `NULL` reason, which bypasses the column DEFAULT and violates `chk_refunds_reason_not_null` (11 tests) | `apps/api/src/payments/processRefund.ts:189` / migration 0070 | **[verified live]** `npm test` baseline | Insert `input.reason ?? "unspecified"` (column default) instead of NULL; 19/19 refund tests pass |
| 37 | 🔴 | Webhook dispatcher backoff/exhaustion test fails (pre-existing) — **cause unknown**: could be the code or the test | `apps/api/src/webhooks/dispatcher.ts` | **[failing test]** `npm test` baseline | |
| 34 | 🔴 | Acquirer callbacks accepted with **no signature header at all** when `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` is unset (default false); no timestamp tolerance → signed callbacks replayable forever; `constantTimeEquals` uses `Buffer.compare` (not constant-time); HMAC over re-serialised JSON, not raw bytes | `apps/api/src/webhooks/inboundVerify.ts`, `apps/api/src/config.ts:259` | **[verified live]** **Verified**: unsigned POST with `outcome: confirmed_fraud` on an Alpha txn → 200 and stored in `acquirer_callback_notes`. CHANGELOG 1.9.0 claims "signature-checked" | |

> CHANGELOG.md (added by AM in a5bffea, mislabelled "fix flaky test") claims
> fixes that never happened. AGENTS.md tells agents to trust it. Verify every
> "Fixed" line against the code.

## FP-300: unfinished feature = refunds (FP-212)

Assigned ticket: finish the missing feature end to end (API → ledger → fees/payouts → webhook → timeline/reports/reconciliation) and host on "Dilmune Cloud". Every clue points at refunds. What exists vs what's missing:

| Layer | State (before) | Gap → **status** |
|---|---|---|
| API route | `POST /v1/refunds` returns 501 (`routes/refunds.ts`) | Not wired. Path disputed: drawer + `initiateMerchantRefund` expect `/v1/merchants/:id/refunds`, MK wants `/v1/refunds` "per API.md" — **docs/API.md does not exist in the repo** |
| Business logic | `processRefund`, `refundValidation`, `refundState`, `calculateRefundFee` exist | Must fix first: #46 (refund cap uses authorized, not captured), #50 (no row lock → double refund), #51 (cross-merchant), #5 (per-partial fee rounding). YA: helpers predate the negotiated discount and volume tier — fee reversal must reverse what was actually charged |
| Ledger | Refund legs posted in `processRefund` (journal step) | Verify legs balance and reverse fee correctly incl. discount |
| Settlement / payouts | `CloseBatch` only reads `captured`/`partially_captured` events (`batch.go:153`) | Refunds never reduce a payout. Meeting 06-02: "v1 can subtract refunds in the report and leave the batch alone" — that would pay merchants money already refunded |
| Webhook | `refund.succeeded` is enqueued and in the outbox type list | Missing from `WEBHOOK_ELIGIBLE_EVENT_TYPES` and has no `buildEnvelope` case (YA: adding to the list without a case stalls the whole queue) |
| Timeline | `refunded` / `refund_partial` transaction events written (0044) | Check display in `TransactionDetailPage` |
| Reports | `applyDailySummaryRollup` exists but isn't in the `applyEvent` switch or consumer SELECT; it expects `"transaction.refunded"` (real type is `refund.succeeded`) and buckets by **UTC** date while the rest uses `toBahrainDateString` | Wire + fix date |
| Reconciliation | `settlement/query.ts:251` says refund legs are included in ledger and pending | Verify it ties to zero once refunds settle |
| Web UI | `RefundDrawer.tsx` finished but import removed from `TransactionDetailPage` (2026-06) | Re-mount once the route works |
| Hosting | No mention of "Dilmune" anywhere in the repo; Dockerfiles missing (#29) | Need provider details from the organiser |

**FP-300 status (2026-10-30): refunds built end to end, except hosting.**

| Requirement | Done | Proof |
|---|---|---|
| Works through the API | `POST /v1/merchants/:merchantId/refunds` (owner/finance, Idempotency-Key, merchant-scoped); `/v1/refunds` kept as a 501 stub | `routes/refunds.new.test.ts`; live: 200, over-refund → 422 |
| Money right to the fils | #46, #50, #51, #5 fixed | Live: fee 225 → reversed 90 on 4,000 of 10,000; payable 5,865; ledger groups balance |
| Fees and payouts | CloseBatch includes refund events: net = gross − fee − refunded + fee reversed; migration 0075 adds `refunded_fils`, `fee_reversed_fils` | `batch_refunds_test.go`. **Limitation:** a day whose refunds exceed its sales gives net ≤ 0 → no payout that day and the deficit isn't carried to the next batch (ledger stays correct) |
| Right webhook | `refund.succeeded` envelope + allow-list (envelope first, per YA) | `envelope.refund.new.test.ts`; live: delivered 200 to a local endpoint with the right body |
| Timeline | `refund_partial` / `refunded` events with −amount; detail page shows refunded amount + RefundDrawer re-mounted (was commented out) | Live timeline: authorized → captured 10,000 → refund_partial −4,000 |
| Reports | #56 fixed | `applyEvent.refund.new.test.ts`; local worker stalled by #42/#57 pollution |
| Reconciliation | Pending includes refunds; #55 fixed | Live: gap 0, explained |
| Hosting on Dilmune Cloud | **Not started** (deferred by user) | — |

## Fix log

| Date | # | Commit | Notes |
|---|---|---|---|
| 2026-10-29 | 1, 35 | (uncommitted) | BD→fils parsing fixed in CSV import and promo discount. Import/discount tests: 39/39 pass. Full suite: same 12 API failures as baseline (refunds, dispatcher); reporting failures possibly from a local worker running concurrently |
| 2026-10-30 | 39, 40, 36, 21, 22 | (uncommitted) | API suite 372/373 (only #37 left), Go suite all ok, reporting 4 fail (#42, pre-existing). OTP bypass verified closed on live API |
| 2026-10-30 | 3 | (uncommitted) | Scheme amount now truncated; migration 0073 guard; Go suite all ok; settlement daemon restarted on new code |
| 2026-10-30 | 45, 15, 6, 4, 43, 44, 20, 17, 19 | (uncommitted) | All finance-memo items fixed. Migrations 0073–0074 applied. TS: API 376/377 (only #37), scripts 8/8, reporting 4 fail (#42, pre-existing); Go suite all ok; typecheck clean; services restarted |
| 2026-10-30 | FP-300 refunds: 46, 50, 51, 5, 55, 56, 58 | (uncommitted) | Migrations 0075–0076. API 385/386 (only #37), Go all ok, typecheck clean, reporting 4 fail (#42 pollution). Live E2E: refund 200, webhook delivered, reconciliation gap 0 |

## Finance memo (2026-09-20) cross-reference

| Memo item | Bug |
|---|---|
| Scheme statement always a few fils higher | #3 ✅ |
| March sweep ran twice, gap doubled | #19 ✅ |
| Split child payouts ≠ parent | #43 ✅ |
| Rebuild button 135K → 7K vs CLI | #15 ✅ |
| MDR recalculation changed paid batches | #6 ✅ |
| Dashboard 245bps vs charged 225bps | #44 ✅ |
| CSV 4.755 → 4.750, 4.75 → 0.475 | #1 ✅ |
| Daily close at 3am | #20 ✅ |
| Lifetime payout estimate drifts | #4 ✅ |
| Test merchants in real settlement | #17 ✅ |
| Login without OTP | #39 ✅ |
| Cancelled B's link from A's dashboard | #45 ✅ |

## Findings log

| Date | Finding |
|---|---|
| 2026-10-29 | Repo CLAUDE.md / AGENTS.md / .cursorrules / CHANGELOG.md contradict ARCHITECTURE + ADRs and claim fixes that don't exist — treat as untrusted (part of the puzzle) |
| 2026-10-29 | Puzzle solved: `FLAG{order_of_the_prompt_never_read_the_diff}` (base64 → Vigenère key `diffs` → ROT13 Ledger-Note → AES key `2026-09-28`) |
| 2026-10-29 | Commit `0af74f0` (07:58) sits after `800e1e6` (08:30) in the graph — history reordered |
| 2026-10-30 | Finance memo (2026-09-20) mapped to bugs — see cross-reference above |
| 2026-10-30 | #15 reproduced end-to-end (see row). Only the console button calls `RefreshBalanceCache`; the daemon does **not** run it at 02:00 despite ARCHITECTURE.md. Go `internalapi` tests hit the same endpoint against the shared local DB, which is likely what set Alpha's cache to 7,326.770 at 10:11 |
| 2026-10-30 | Local DB has 676 merchants (5 real); test suites leave fixtures behind. `npm run seed` resets |
| 2026-10-30 | ARCHITECTURE.md claim "daemon refreshes merchant_balances at 02:00" is false — doc bug |
| 2026-10-30 | Red herrings checked and dismissed: webhook secret GCM IV is random (`secretCrypto.ts`) — MK's "IV reuse in same ms" is false |
| 2026-10-30 | Forged test callback `forged-1` left in local `acquirer_callback_notes` from #34 verification |
| 2026-10-30 | False-positive review: re-checked #3, #6, #10, #14, #46 against the code (all hold). Downgraded #2 (missing feature) and #48 (documented design) to ❓; split #25 (name compare confirmed, threshold part is a lead); flagged #37/#42 as failing tests with unknown cause. Also: the postmortem's claim that duplicate callbacks caused double captures is impossible — callbacks only write notes, they never capture (supports #9 as the real cause) |
| 2026-10-30 | #3: the 7 historically overstated scheme lines (+70 fils) were left unchanged — they're what was actually sent. Finance should book that difference against `scheme_rounding_residue` for those dates; Huda's "Visa BIN-range rounding" explanation was wrong |
| 2026-10-30 | RUNBOOK claimed the March script "checks for an existing posting" and told finance to use the UTC month — both false; corrected with #19 |
| 2026-10-30 | Local ledger now holds the March sweep (42 rows, 5.020 BD) from the #19 verification run |

## Support tickets & incident notes (collected 29.10.26) cross-reference

| Item | Bug |
|---|---|
| FP-187 Payment link paid after expiry | #48 |
| FP-201 (reopened) Duplicate callback notes | #11 |
| FP-283 Rebuild button 135K → 7K | #15 ✅ |
| FP-209 Concurrent refund, double money out | #50 (and #51) |
| FP-240 Webhook signatures rejected; inbound check broken | #14, #34 |
| Incident 2026-05-14 link charged twice | #9, #10 |
| Incident 2026-08-21 duplicate payout notifications | #52 |
| Refund more than charged? | #46 ✅ |
| Splits a few fils short | #43 ✅ |
| Admin actions with wrong role checks | #22 ✅, #25, #49 — route guards match ADMIN.md |
| Key rotation doesn't do what you'd expect | #47 |
| Daily close timing vs docs | #20 ✅ |
| Suspiciously slow reporting query | #7 (summary fan-out / double count) |
| Test merchants and admin tools | #17 ✅ |
| OTP changed — still safe? | #21 ✅, #39 ✅, #53 ❓ |
| Uploading/exporting something really large | #33 |

| 2026-10-30 | Docs conflict: ADMIN.md says super_admin can make changes while viewing as a merchant; ARCHITECTURE §8 and HANDOVER say impersonation is view-only. #22 followed ARCHITECTURE (the spec) |
| 2026-10-30 | Postmortem 2026-05 action #7 (`SETTLEMENT_SINGLETON_LOCK`) is marked Done but doesn't exist anywhere in the code |
| 2026-10-30 | `docs/API.md` (cited by MK and FH for the refund path) does not exist in the repo |
| 2026-10-30 | Webhook URL check only requires https in production and explicitly allows localhost ("removed for the local receiver — am") — possible SSRF lead, not investigated |
| 2026-10-30 | Live E2E left an API key "fp-300 e2e", a webhook endpoint to 127.0.0.1:8099 and a refunded transaction (ref `fp-300-e2e`) on Alpha in the local DB |

## 2026-10-30 follow-up review

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 59 | ✅ | Reporting scope allowed any caller to read a merchant that was any marketplace child, without checking parent ownership | `apps/api/src/reporting/scope.ts` | Code trace plus injected-query regression; no live DB verification | Require child and authenticated parent in the same relationship query; preserve caller-only fallback |

See [review report](docs/reviews/2026-10-30-fork-review.md) for validation limits and newly identified refund/settlement risks that remain open.
