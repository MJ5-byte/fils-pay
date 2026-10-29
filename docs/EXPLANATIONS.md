# FilsPay "The Handover" — bug explanations

Every planted bug the case files point to, with what was wrong, why, what it
breaks, and the fix. Written as the EXPLAIN half of the FilsPay hackathon
brief ("For each bug, write a short note: what's wrong, why, and what it
breaks"). Each fix landed as its own commit; see the commit list at the end.

Notation: ids match the case-file bug list (B1–B24), the refund feature
(F1–F5) and the mystery/seed items (M1/M2).

---

## Money & ledger

### B1 — Adjustment CSV import reads BD amounts 10x off
- Wrong: `apps/api/src/lib/decimal.ts` parses a string with a **2-decimal**
  ("cents") default and `apps/api/src/admin/adjustmentCsvParsing.ts` brands the
  result as **fils**. BD has three minor units (1 BD = 1000 fils), so `4.75`
  became `475` fils (0.475 BD) and the third digit was silently dropped
  (`4.755` → 475).
- Why: the importer used a general two-decimal helper instead of the money
  package's `parseBhdToFils`; ADR-0001 forbids "BD × 100" style conversion.
  Commit 9567ea0 even recorded MK claiming it "is in the tests" — the tests
  pinned the wrong value.
- Breaks: finance uploads a 4.75 BD adjustment, the ledger posts 0.475 BD —
  a 10x under-credit to merchants, corrupting balances and reconciliation.
- Fix: `parseAdjustmentAmountFils` delegates to `parseBhdToFils`; the pinned
  tests now expect `4.75` → `4750` fils. (`c-apicore`)

### B2 — Settlement split payouts are a few fils short (children ≠ parent)
- Wrong: `apps/settlement/internal/splits/shares.go` / `allocate.go` rounded
  each child's share with `ApplyRateFils` **independently**, so `Σ shares ≠
  net_payout` for almost every real amount (e.g. 101 fils over 3333/3333/3334
  → 33/33/33 = 99). The leftover was posted nowhere, and `ApplyPayout` got the
  rounded sum, so the parent's cache also drifted.
- Why: no largest-remainder allocation step; each share rounded half-to-even
  on its own. Also a second mechanism: `payable.go` computed net payout via a
  **float32** BD value, which drifts past 2^24 fils.
- Breaks: missing fils in the merchant's payable every batch (finance's
  "where do the missing fils go?"), and balance-cache drift.
- Fix: a Go `AllocateRemainder` (largest-remainder, ties by ascending child
  index) used by both `ChildShares` and `PayoutSplitBatch`; `ApplyPayout`
  receives the exact net. `NetPayableFils` is now plain integer
  `gross − fee`. (`c-go`)

### B3 — Scheme statement a few fils higher than ours; residue never posted
- Wrong: (1) CloseBatch never posted the ADR-0002 residue group
  (`scheme_rounding_residue` existed but no writer); (2) the exported line
  `amount` was `float64(gross)/1000` on the **untruncated** gross, and the
  `numeric(10,2)` column rounds **up** half-away, e.g. 4747 fils →
  `amount_fils` 4740 but `amount` 4.75.
- Why: the residue posting was half-implemented (ADR-0002 "implemented in
  March 2026" was never true); the float path bypassed the truncation that
  `amount_fils` already carries.
- Breaks: the scheme statement never reconciles to ours (residue is both
  unjournaled and mis-quoted), so finance can't tie the month.
- Fix: derivation from the truncated integer (`num(file)=amount_fils/1000`;
  `4740` → `4.74`) and a balanced residue group per line inside CloseBatch.
  (`c-go`)

### B4 — MDR recalculation rewrites already-paid batches
- Wrong: `apps/settlement/internal/settlement/recalculate_mdr.go` selected
  `AND status <> 'open'`, which includes **paid** batches, then rewrote their
  frozen `fee_fils`/`net_payout_fils` and posted compensating legs.
- Why: the filter meant "not open" instead of "still unpaid"; the admin route
  doc promises paid batches are never touched.
- Breaks: a paid-out batch's history, disbursement record and merchant payout
  silently diverge from what was actually disbursed.
- Fix: `AND status = 'closed'` plus a paid-batch regression test. (`c-go`)

### B5 — March sweep script is not idempotent (ran twice → gap doubled)
- Wrong: `scripts/reconcile_march.ts` generated a **fresh** `entry_group_id`
  per run, inserted with no existing-posting check, and read rows outside the
  transaction. Nothing stops a second run sweeping the same rows again.
- Why: the "dedupe" relied on a UUID that changed each run; the RUNBOOK even
  told operators re-running was safe.
- Breaks: running the month-end cleanup twice (staging did exactly this)
  doubles the posted residue and doubles the ledger gap.
- Fix: one transaction, `INSERT … WHERE NOT EXISTS` on the fixed description,
  plus the Asia/Bahrain month window (the UTC month misattributed the 3-hour
  edges). RUNBOOK corrected. (`c-scripts`)

### B6 — Dashboard shows 245bps, capture charges 225bps
- Wrong: `currentFeeScheduleDisplay.ts` picked the row with the newest
  `created_at`, so a backdated correction row (older `effective_from`, later
  `created_at`) won the display, while billing (`feeSchedule.ts`, Go) resolves
  by `effective_from`.
- Why: two reader conventions on the same table; the display helper
  "did the opposite on purpose" — a doc-confirmed trap.
- Breaks: merchants see a rate nobody is charged; support/finance get
  contradictory numbers from the same merchant.
- Fix: display filters `effective_from <= now()` and orders by
  `effective_from DESC, created_at DESC`; the backfill-wins test flipped.
  (`c-apicore`)

### B7 — "Recalculate cached balances" gave 135K→7K while the CLI is right
- Wrong: the button called `RefreshBalanceCache`, which reads
  `merchant_payable_position` (a gross scheme-export sum, no fees, no status
  filter, no refunds) — while the CLI `rebuild-balances` walks the ledger
  (`merchant_payable` net). Two genuinely different sources.
- Why: ADR-0004 documented two rebuild paths by design, but the button's
  "fast" path read a table that is not the source of truth.
- Breaks: clicking the button silently replaces a merchant's correct
  balance with the scheme-gross figure (the 135K→7K crash).
- Fix: `handleRebuildBalances` now calls `RebuildAllBalances`, the same ledger
  rollup as the CLI; the server test that had encoded the wrong source was
  rewritten. (`c-go`)

### B8 — Refund ceiling used the authorized amount, not what was captured
- Wrong: `processRefund` computed `refundableFils = amountAuthorized −
  refunded`, so a partially captured transaction (authorized 10 000, captured
  4 000) could be refunded up to 10 000 and could even keep "refunding" after
  it was fully refunded.
- Why: ceiling followed the authorize number instead of the capture number
  (the finance rule: "a transaction is refunded when every fils we captured
  went back").
- Breaks: refunds move money that was never captured; over-refunds.
- Fix: `refundableFils = capturedFils − refundedFils`. (`f8846e8`)

### B9 / FP-209 — Concurrent refunds double money out
- Wrong: `processRefund` claimed + validated the transaction with **no row
  lock**, then called the acquirer and journaled in a later transaction, so
  two simultaneous refunds (different idempotency keys) both read
  `refunded_fils = 0`, both refunded at the acquirer, both journaled. Payments
  (capture) hold a `SELECT … FOR UPDATE` across the call; refunds did not.
- Why: the refund's three-phase shape (claim → acquirer → journal) dropped the
  lock capture keeps.
- Breaks: money out twice for one transaction, hidden by a row that
  "looks" refunded once.
- Fix: the whole refund is one transaction holding `SELECT … FOR UPDATE`
  across the acquirer call — the loser re-reads the committed refunded state
  and is rejected (409) before any acquirer money moves. Regression test
  added. (`f8846e8`)

### B10 — Lifetime payout estimate drifts for high-volume merchants
- Wrong: `payout_estimate.go` accumulated into a `REAL` (float32) column; past
  2^24 fils each delta rounds, so large merchants "drift" monotonically. The
  split-payout path never updated it at all.
- Why: monitoring column sized for small values; the float32 unit type.
- Breaks: the monitoring estimate becomes meaningless for real merchants.
- Fix: `merchants.lifetime_net_payout_monitoring_estimate` and
  `platform_stats.total_processed_fils` widened to `BIGINT` (0074) with int64
  accumulation, and the updater also runs on split payouts. (`c-go`)

---

## Security

### B11 / FP-240 — Webhook signatures rejected by merchants
- Wrong: the dispatcher HMAC'd a **re-canonicalized** JSON
  (`canonicalJson(payload)`) but sent the **raw** `JSON.stringify` bytes on the
  wire (and Postgres re-orders jsonb keys on read, so neither matched).
  Merchants verifying over the exact received bytes always failed.
- Why: "sign the exact bytes we send" (YA's `ya/sign-raw` branch) was never
  merged — the branch commit was empty.
- Breaks: every merchant webhook signature check fails (FP-240); a real
  receiver cannot verify delivery.
- Fix: `signPayload` now signs the pre-serialized body string verbatim; the
  sender builds the body once and signs those bytes; tests verify over raw
  bytes and assert a byte mismatch → `signature_mismatch`. Verified on a live
  delivery end-to-end. (`c-webhooks`)

### B12 — Merchant login works without entering the OTP code
- Wrong: the `live_sessions` view (0058) included pre-OTP **pending** sessions,
  so a login-step cookie authenticated every merchant route before OTP anyway.
  The admin side filters `authenticated = true`; the merchant side didn't.
- Why: one view was the merchant auth predicate and its predicate omitted the
  OTP-verified column.
- Breaks: password-only login (no OTP) is a full merchant session — account
  takeover with just a password.
- Fix: `AND authenticated = true` in the view + a route regression test
  (pending cookie → 401). Also fixed: OTP recipient resolved by email across
  merchants, the OTP guess race, resend budget reset, session-fixation
  (token rotation) — documented in `a-a-auth.md`; the email-binding fix is a
  follow-up item tracked below. (`0446569` + follow-up)

### B13 — Cross-merchant payment-link cancel (A cancels B's link)
- Wrong: `cancelPaymentLink` filtered only `status='active'`, never the owning
  merchant; the route checked the *path* merchant, not that the link belonged
  to it.
- Why: the ownership check compared the URL params, not the resource; the
  "UUIDs are unguessable" excuse was obscurity.
- Breaks: any authenticated merchant can cancel another merchant's active
  payment link (business disruption / fraud).
- Fix: `AND merchant_id = $2` on both the update and the lookup; another
  merchant's link is a 404. Regression test added. (`c-paylinks`)

### B14 — Payment link is payable after expiry (server trusts the client clock)
- Wrong: the public pay route accepted a client-supplied `submittedAt` for the
  expiry check (the "offline terminal" path), and the documented "ignored
  unless authenticated with an API key" gate did not exist — the hosted
  checkout always sent it.
- Why: the trust boundary described in ARCHITECTURE was never implemented.
- Breaks: an expired link can be paid by sending any pre-expiry instant;
  buyers "charged" through an expired link.
- Fix: implemented the gate — `submittedAt` is honoured only with valid
  API-key auth, otherwise the server clock decides. Regression test added.
  (`c-paylinks`)

### B15 / Incident 2026-05-14 — Payment link charged twice (one link, two buyers)
- Wrong: the claim→capture→finalize flow released the link reservation after
  claim, so a second buyer could re-claim a reserved-but-not-yet-finalized link
  after the timeout; the losing finalize matched zero rows but still returned
  **200 paid** with the charged transaction.
- Why: nothing made the winning capture conditional on still holding the
  reservation, and the 0-row finalize path lied about success ("this IS
  reachable" comment).
- Breaks: two cards charged for one single-use link; orphan captures.
- Fix: `payPaymentLink` never returns 200 on a 0-row finalize — it voids the
  orphan capture and returns a real error. (`c-paylinks`)

---

## Reliability

### B16 / FP-201 — Duplicate acquirer-callback notes
- Wrong: `applyAcquirerCallback` inserted a note with no dedup, and no unique
  constraint existed on `callback_id`; the sandbox reuses callback ids across
  transactions, so dedup scope must be `(transaction_id, callback_id)`.
- Why: every "dedup shipped" artifact was fabricated — the 11:20 hotfix commit
  was empty, the CHANGELOG entries were a docs-only backfill, the
  postmortem action item cited a `processed_events` table that never existed.
- Breaks: the bank's redelivered verdict creates a second identical note on
  the timeline, confusing support/finance.
- Fix: unique index 0073 on `(transaction_id, callback_id)` + an idempotent
  `ON CONFLICT DO NOTHING` insert; regression test (same signed body twice →
  one note). Also hardened the endpoint: outcome enum + ISO `occurredAt`
  validation (were 500s), server-side `received_at`, and the shipped
  `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true`. (`0446569`)

### B17 — Duplicate payout notifications / disbursement rows
- Wrong: `payout_notify`'s `NOT EXISTS` scan was not race-safe (two processes
  both pass under READ COMMITTED) and `outbox_events` had no unique on
  `(event_type, aggregate_id)`; the dedup claim in code was fiction. On the
  webhook side, `recordPayoutDisbursementEffect` inserted a disbursement row
  with no unique on `settlement_batch_id`, and replays minted a fresh
  `delivery_event_id` (contradicting the stable-id contract).
- Why: multiple layers each "thought they were first".
- Breaks: merchants get two "payment on the way" messages + duplicate
  disbursement records for one payout.
- Fix: `settlement.paid` dedup is now a unique index scoped to that event
  type (0075; a global index would wrongly reject second partial-capture /
  refund events), the notify insert is `ON CONFLICT DO NOTHING`,
  `settlement_payout_disbursements` got a partial-unique + idempotent effect
  (0076), and replays reuse the original `delivery_event_id`. (`c-go` +
  `c-webhooks`; the over-broad 0075 was corrected to the partial index by the
  orchestrator after a suite failure in multi-capture tests.)

### B18 — Daily close at ~03:15 local instead of 00:15 (UTC vs Asia/Bahrain)
- Wrong: `BusinessDayWindow` called `date.Date()` on the argument in **its
  own** location; the daemon passes UTC, so between 21:00–24:00Z it computed
  the previous Bahrain day and closed two days behind.
- Why: the window didn't normalise to the business-day location first.
- Breaks: settlement closes hours late; a day's captures open late; the "3am
  local" symptom from finance.
- Fix: `date.In(businessDayLocation).Date()`; the compat test that had
  encoded the off-by-one was replaced. (`c-go`)

### B19 — Test merchants in real settlement runs
- Wrong/verified: the Go daily-batch scans already filter
  `test_mode = false` (close and full run), so no Go bug was found; the
  reproducible defects were data-level — the seed gave test-mode
  `gamma-hospitality` a full closed batch + outbox events, and `production_seed.sql`
  shipped a test-mode merchant in the "production" dump.
- Breaks: test volume in a real-looking batch/report; misleading demos.
- Fix: the seed generator skips ledger/settlement/outbox for `testMode`
  merchants (M1-T2); the corrupt dump was deleted (M1-P). (`c-seed`)

### B20 — Missing role gates (credit creation) + impersonation role escalation
- Wrong: the **credit-create** route (`POST /v1/admin/merchants/:id/credits`)
  sat behind only `requireAdminSession`, so a `support` admin could post a
  below-threshold credit that journals **real money immediately**. And
  impersonation mapped `finance → merchant finance` / `super_admin → merchant
  owner`, letting a view-only-admin impersonator write (create payment links /
  webhook endpoints) as the merchant with no admin audit.
- Why: two places where an admin role actually moves money had no role gate;
  the impersonation "view-only" doc was contradicted by its own mapping.
- Breaks: privilege misuse (money moved by support; impersonation writes).
- Fix: `requireAdminRole("finance","super_admin")` on credit creation (with a
  support-403 regression test); `MERCHANT_ROLE_FOR_ADMIN_ROLE` now maps every
  admin role to `support` so impersonation is genuinely read-only. (`orchestrator`)

### B21 — Webhook secret key rotation silently destroys delivery
- Wrong: `webhook_endpoints.secret_ciphertext` (AES-256-GCM) has no key
  version; decrypt uses the current `WEBHOOK_SECRET_ENCRYPTION_KEY`. Rotating
  that key makes every stored secret undecryptable, and the dispatcher's
  per-row catch leaves those deliveries **pending forever** with no alert.
  There is no rotate/re-encrypt path.
- Why: the ciphertext doesn't carry which key encrypted it (no dual-key
  window).
- Breaks: a "security: rotated everything again" style rotation would silently
  freeze all webhook delivery.
- Fix (documented): versioned ciphertext / key-id + accept previous key during
  rotation + atomic re-encrypt; flagged as a follow-up, no code change in this
  pass. (`c-webhooks`)

### B22 — One reporting query suspiciously slow (full scan per request)
- Wrong: `getRecentLedgerActivity` wrapped the indexed column
  `(occurred_at AT TIME ZONE 'Asia/Bahrain')::date` — non-sargable, so the
  planner full-scanned the merchant's whole ledger every request — and `to`
  was inclusive (rows on a boundary appeared in two windows).
- Why: the timezone cast defeated the `(merchant_id, occurred_at)` index.
- Breaks: slow analytics for any merchant with history.
- Fix: Bahrain-midnight UTC instants computed in SQL with bare `occurred_at
  >= / <` (index scan, `to` exclusive). Boundary-exclusion test added.
  (`c-apicore`)

### B23 — Large export untested; the streaming twin was dead and broken
- Wrong: the transactions CSV export loaded the whole result into memory, and
  the streaming helper it should have used was never wired and used a
  timestamp-only cursor (rows sharing one timestamp were silently skipped at
  page boundaries).
- Why: the stream path existed but had zero callers and a broken keyset.
- Breaks: OOM / drop on the 512 MB API for a busy merchant; silently missing
  rows in exports.
- Fix: route now streams via a proper `(occurred_at, id)` keyset cursor with
  an id tie-break; a >1000-row paged test proves no skips. (`c-apicore`)

### B24 — Docker compose cannot build (Dockerfiles never existed)
- Wrong: `ops/docker-compose.yml` references `ops/Dockerfile.node` and
  `ops/Dockerfile.go`, which were **never in any commit** (the initial ops
  commit lacks them; MK's "pull main again" claim was false). Two further boot
  blockers: the settlement daemon **requires** `SETTLEMENT_INTERNAL_TOKEN`
  (the "dev-token default" is doc fiction) and `.env.docker` was never loaded
  (no `env_file`) so production posture never applied.
- Why: docs promised files/behavior that don't exist.
- Breaks: `docker compose up` cannot build; the daemon exits at boot without
  the token; the whole file was inert.
- Fix: wrote `ops/Dockerfile.node` (node:20-slim, `npm ci`) and
  `ops/Dockerfile.go` (multi-stage go build → slim), wired
  `SETTLEMENT_INTERNAL_TOKEN` + `env_file: .env.docker` per service, and added
  the webhook encryption key to `.env.docker`. (`orchestrator/infra`)

---

## Refunds feature (the never-shipped feature)

### F1 — POST /v1/refunds was a 501 stub
Wrong: the route existed but returned `not_implemented` with FP-212 comments
saying the helpers were "done and tested". Why: nobody wired it (and YA warned
the helpers predate the capture discount). Breaks: merchants can't refund.
Fix: wired `POST /v1/refunds` to `initiateMerchantRefund` (authenticated
merchant, `transactionId` + `Idempotency-Key` required, `amountFils`
validated, writer avatar via `requireMerchantWriterActor`). (`5fe1d4a`)

### F2 — Fee reversal was not discount-aware / fee computed three ways
Wrong: `processRefund` summed only `platform_fee_revenue` **credit** legs, so
a refund on a negotiated-discount merchant reversed the pre-discount fee (an
over-reversal); separately, settlement's `ComputeSettlementFee` applied the
discount **before** MDR while capture applies it after (a ~1-in-5 fil tension
for discounted merchants), and the reconciliation estimate used float
half-up rounding.
Why: the capture books the discount as a **separate** post-commit leg; three
independent fee computations disagreed.
Breaks: discount merchants get double-credited on full refunds; booked fees
vs settlement drift by fils.
Fix: `processRefund` nets the discount leg (excluding `refund:%` legs)
(`f8846e8`); `ComputeSettlementFee` is fee-then-discount and the estimate is
integer `applyRateFils` (`c-go`, `c-apicore`).

### F3 — `refund.succeeded` wasn't shippable (queue-stall hazard + not wired)
Wrong: adding the type to `WEBHOOK_ELIGIBLE_EVENT_TYPES` without a
`buildEnvelope` case throws inside Step A's transaction, stalling the whole
webhook queue (YA's warning); the type wasn't added at all, so no refund
webhook could ever deliver.
Fix: envelope case added **first**, then the eligibility-list entry, then the
envelope case test. (`5fe1d4a`) Verified: a real refund delivered a
`refund.succeeded` webhook end-to-end.

### F4 — UI surfaces
- Merchant web: revived the parked `RefundDrawer`, wired it to
  `POST /v1/refunds` with correct fils display and Idempotency-Key
  (`apps/web/src/...RefundDrawer.tsx`, `TransactionDetailPage.tsx`,
  `api/transactions.ts`, `format.ts`). Typecheck clean, `vite build` ok, web
  tests 8/8.
- Admin console: no refund surface or admin refund route exists (the
  CHANGELOG's "RefundDrawer (behind a flag)" is the parked web component).
  Refunding must go through the merchant surface or a new admin route;
  impersonation is deliberately view-only after B20. Documented, not a bug
  left open.
- Reporting/reconciliation: the consumer now ingests `refund.succeeded` into
  `merchant_daily_volume.refund_count/refund_gross_fils` (0077) bucketed by
  Asia/Bahrain day, and refreshes the `refund_merchant_summary` materialized
  view (0072 join fixed to `t.id = r.transaction_id`). (`c-reporting` +
  `5fe1d4a`)

### F5 — Refund ledger/rows correctness
Wrong details: `refund_merchant_summary` joined `t.id = r.id` (refund UUID vs
transaction UUID → returned no rows ever, so reconciliation was always
empty); `processRefund` inserted a NULL `reason` against a `NOT VALID` NOT
NULL CHECK (0070) → txn3 aborted with a 500 *after* the acquirer refunded
(money out, unjournaled). Fix: join `t.id = r.transaction_id` (`5fe1d4a`);
reason defaults to `'unspecified'` (`f8846e8`). The double-entry refund group
nets to zero by 0007's deferred constraint — verified on a live refund.

---

## Mystery (the three transmissions) and seed corruption

### M2 — The three transmissions decoded → FLAG
- t1 (`fe24d26`, Base64): "…never read the diff. Read it. The next door opens
  with the victim of that rule: five letters, lowercase."
- t2 (`8022020`, Vigenère keyed **DIFFS** — the victim of rule two is the
  diffs themselves; "Blaise would know"): "THE KEEPER LEAVES A NOTE IN EVERY
  COMMIT HE WRITES. FIND IT. ROT THIRTEEN." → the Keeper of Logs (Ali) leaves
  ROT13 Ledger-Notes in commit bodies; `800e1e6`'s note decodes to "the last
  door is a date… find the commit made under yousif's name after his account
  was deleted. write its day as year-month-day."
- t3 (`0af74f0`, AES-256-CBC, passphrase **2026-09-28**, the author date of
  the post-deletion commit `098c2de`): "YOUSIF WAS NOT TAKEN. HE WAS
  ERASED. The Order of the Prompt is not four people. Every 'Claude says'
  comment is a member and every locked test is a vow… His fixes still exist:
  ya/sign-raw, the abandoned migrations, the warnings in the handover. Fix
  what he started and he returns to the record.
  **FLAG{order_of_the_prompt_never_read_the_diff}"**
- Conclusion: the planted bugs are the members of the Order — marked by
  "Claude says" comments and locked in by tests that assert the wrong behavior
  ("it is in the tests"). Fixing them is the point of the exercise.

### M1 — Seed corruption
- `db/seed/fixtures/transactions.ts` (the 098c2de Yousif-committed file) is
  internally **clean** — a legit generator; its post-deletion date was a
  red herring (the commit is a forged `placeholder` committer).
- The real corruption lived in `db/seed/fixtures/production_seed.sql`:
  fabricated data that cannot even import (event_type CHECK violation),
  single-leg unbalanced ledger groups, `refunded` transactions with zero
  captures, transactions dated after the dump's own snapshot, fabricated
  batches whose fees don't reconcile, duplicate acquirer references, and a
  test-mode merchant in a "production" dump. It was referenced nowhere, so it
  is deleted.
- Data-level seed bugs fixed: alpha-retail booked at 250bps despite its own
  225/245 schedule (now booked at the effective rate, batch fee 164,853 vs
  183,174); test-mode gamma got a full settlement batch (now skipped).
  (`c-seed`)

---

## Commit list
```
0b7e9f4 fix(db): a fresh database migrates cleanly again
f8846e8 fix(refunds): let exactly one refund through, on the captured total
8938ae8 docs(plans): add handover hackathon plan
0446569 fix(auth, callbacks): pending sessions authenticate nothing; callbacks dedupe
5fe1d4a feat(refunds): wire POST /v1/refunds, ship refund.succeeded webhooks
The full commit set is listed in `docs/ENGINEERING.md` §6.
```