# FilsPay — Engineering Guide (ownership reference)

This is the engineering document written for the Handover hackathon delivery. It
sits alongside `docs/EXPLANATIONS.md` (the per-bug what/why/what-breaks
write-up), `docs/SUMMARY.md` (the plain-language story) and
`docs/TEACHING.md` (a sit-down teaching + run-it-yourself script). Together they
let us own the app the way its authors did. Everything here describes the repo
**as it is after our fixes** — this is not the pre-hackathon lore, and any
pre-existing doc that contradicted it was corrected as part of the work.

---

## 1. What FilsPay is, in one paragraph

FilsPay is a payment platform for Bahrain. A merchant signs up, goes through KYC,
takes card payments in Bahraini Dinar (BD), and is settled — the money lands in
their account — on a daily schedule. Every amount is stored and computed as an
**integer number of fils**, where `1 BD = 1000 fils`. Three services around one
Postgres database make this happen: an HTTP API, a Go settlement daemon, and a
reporting worker — plus a merchant dashboard and an ops console written in React.

---

## 2. The stack at a glance

| Component | Language | Job |
|---|---|---|
| `apps/api` | TypeScript / Fastify | Merchant + admin HTTP API; auth (password + OTP, admin roles); authorize/capture/void/refund; payment links; webhook dispatcher; acquirer client; integration of settlement's internal API |
| `apps/settlement` | Go | Daily batch close, per-event fees, payouts, scheme file export, balance cache, internal HTTP API on `:8091` |
| `apps/reporting` | TypeScript | Reads the outbox and updates the analytics read model (`merchant_daily_volume`, `merchant_payout_trends`), refreshes the refund summary |
| `apps/web` | React / Vite | Hosted checkout + merchant dashboard |
| `apps/admin` | React / Vite | Ops console (finance/support/super_admin) |
| `packages/money` | TypeScript | Branded integer-fils arithmetic (single source of truth) |
| `packages/events` | TypeScript | Outbox event types + `enqueueEvent` |
| `db/migrations` | SQL | Postgres schema, numbered `0001`–`0077` |
| `scripts/` | TypeScript | One-off ops (March reconciliation, expire holds) |
| `ops/` | docker-compose | The local/ hosted stack + env + the Dockerfiles (we added) |

Services communicate almost entirely through the **database**: a transactional
outbox plus `LISTEN/NOTIFY` for wake-ups, and a small authenticated internal HTTP
API on the settlement worker for admin-triggered operations.

---

## 3. The money model (read this twice — everything else hangs off it)

**ADR-0001 — money is integer fils everywhere.** The Bahraini Dinar has three
minor units (`1 BD = 1000 fils`). Long ago, two-decimal assumptions corrupted a
batch by 4 fils, so the rule is total: every monetary column is `BIGINT` ending
in `_fils`; every API payload uses integer fils; TS carries the branded `Fils`
type; Go uses `money.Fils` (`int64`). Float arithmetic on money is a review
blocker, and `toFixed(2)`/`parseFloat` are never correct for BD.

`packages/money/src/fils.ts` is the whole toolbox:

- `toFils` — brands a safe integer as `Fils` (rejects negatives unless asked).
- `parseBhdToFils("4.75")` — parses a `D.DDD`/`D.D`/`D` string **exactly** to
  fils (never via float): `"4.75"` → `4750`, `"0.005"` → `5`.
- `bankersRoundDiv` — round-half-to-even integer division via `bigint`
  (no float ever touches money).
- `applyRateFils(amount, basisPoints)` — one rounding, half-to-even. This is the
  **single** rate primitive; fees are `amount × rate / 10000`, rounded once.
- `allocateRemainder(total, weights)` — largest-remainder split, guaranteed to
  sum **exactly** to the total, ties by ascending index. This is what settlement
  splits use (Go port added in our fix).
- `calculateRefundFee(captured, feeCharged, refunded)` — proportional fee
  reversal, half-to-even.
- `formatBhd(fils)` — display only: `4750` → `"4.750"`.

**The ledger is double-entry.** `ledger_entries` records every money movement as
two or more legs sharing one `entry_group_id`; a deferred constraint trigger
(migration 0007) refuses to commit any group whose debits ≠ credits. This is a
hard invariant — a buggy write *fails closed* rather than silently unbalancing.
The chart of accounts (`chart_of_accounts`, seeded in 0007 + additions):

- `merchant_payable` (liability) — what we owe the merchants.
- `platform_fee_revenue` (revenue) — our cut.
- `card_scheme_clearing` (asset) — the money at the card network.
- `platform_cash` (asset) — our operating cash.
- `scheme_rounding_residue` (suspense) — 0–9 fils truncated per line at the
  scheme, where it is journaled each close (ADR-0002; we implemented the
  posting that had never existed).
- `fx_rounding_difference`, `chargeback_suspense`, goodwill/manual-adjustment
  accounts for reconciliation lanes.

`merchant_balances.cached_payable_fils` is a **cache** of what a merchant is owed,
rolled up from the ledger. Both the CLI (`settlement rebuild-balances`) and the
admin button now use the same ledger rollup — a bug we fixed (B7) where the
button read a different (scheme-gross) table and could show 135K → 7K.

---

## 4. Core flows

### 4.1 authorize → capture → void → refund

- **Authorize** (`POST /v1/transactions`): validates the card with the acquirer
  client (a simulator in dev), books an authorization, holds the amount. A
  `hold` row records the reserved funds.
- **Capture** (`POST /v1/transactions/:id/capture`): requires an authorized
  (or partially captured) transaction. It `SELECT … FOR UPDATE`'s the row and
  holds the lock across the acquirer call, computes the fee
  `applyRateFils(captured, effectiveMdr − volumeTierBonus)`, and posts a balanced
  ledger group (clearing credit = gross, fee revenue + merchant payable on the
  other side). Sets `captured_fils` + status.
- **Void**: releases the hold for an unauthorized transaction. Captured
  transactions cannot be voided.
- **Refund** (the feature we shipped — §7): full or partial, via
  `POST /v1/refunds`, wired to `initiateMerchantRefund` → `processRefund`.

Idempotency protects every write: `idempotency_keys` with a
`UNIQUE(merchant_id, endpoint, key)` constraint. A client sends an
`Idempotency-Key` header; the same key + body replays the same response with no
second write; the same key + different body is rejected; a different key is a
fresh request. This is the mechanism that makes both payments and refunds safe
against retries and races.

### 4.2 Payment links

Merchants create single-use links. The schema enforces single-use:
`CHECK ((status = 'paid') = (transaction_id IS NOT NULL))`. Our fixes:
- **cancel** is now merchant-scoped (B13) — a merchant can only cancel their own.
- the public pay route honours a client `submittedAt` **only** under valid
  API-key authentication, otherwise the server clock decides expiry (B14).
- losing a finalize race never returns a fake 200 (B15).

### 4.3 Webhooks (the outbox)

When an event happens (a capture, a void, a payout, a refund), `enqueueEvent`
inserts an `outbox_events` row **in the same transaction** as the write that
produced it. The dispatcher (in-process in `apps/api`) wakes on
`LISTEN/NOTIFY` and on a poll timer, and runs one idempotent pass:

- **Step A**: for eligible event types, create a `webhook_deliveries` row per
  active endpoint that has none (a partial unique index makes concurrent passes
  safe).
- **Step B**: for each due delivery, decrypt the endpoint secret, sign the
  payload, `POST` it, record the outcome, and back off exponentially on failure.

Our signing fix (B11/FP-240) is the load-bearing one: the HMAC now covers **the
exact bytes put on the wire** (`timestamp + body`), not a re-serialization, so a
merchant who verifies over the raw received body succeeds. Delivery id is
stable across retries **and replays** (B17). Eligible types:
`transaction.captured`, `transaction.voided`, `settlement.paid`,
`refund.succeeded` (we added the last, with its envelope case first — F3).

### 4.4 Settlement (Go)

- The business day is Asia/Bahrain midnight→midnight (`window.go`, our B18 fix
  normalises to that zone before taking the date, so close happens on time).
- **CloseBatch** (per merchant, per day): `SELECT … FOR UPDATE` the eligible
  capture events, compute each event's fee with the effective fee schedule,
  truncate each scheme line to a multiple of 10 fils, **post the truncation
  residue** to `scheme_rounding_residue` (our B3 fix), then write the batch
  (`settlement_batches`, status `closed`).
- **PayoutBatch**: flips `closed` → `paid`, posts the payout ledger legs, and
  enqueues `settlement.paid` (our fix — it previously never emitted, so payout
  notifications and the reporting "paid" state were dead).
- **Notify**: enqueues one `settlement.paid` outbox row per paid batch; a unique
  index scoped to that event type makes concurrent callers safe (B17).
- **MDR recalculation** touches only `status = 'closed'` batches (B4) — paid
  batches are frozen.
- **Splits**: a parent merchant with sub-merchant children has its net payout
  split across them by largest-remainder (our B2 fix — previously each child was
  rounded independently and the shares didn't sum to the parent's net).
- **Balance cache**: `RebuildAllBalances` walks the ledger (B7).
- Amounts are int64; the monitoring counters were widened to `BIGINT` (B10).

### 4.5 Acquirer callbacks

The acquirer can post out-of-band verdicts (e.g. `fraud_review.completed`).
`applyAcquirerCallback` appends a note to `acquirer_callback_notes`, **deduped
on `(transaction_id, callback_id)`** (B16/our fix — the sandbox reuses callback
ids across transactions, so callback-id alone is not a safe key). The endpoint is
signature-checked and the shipped environment now requires signatures (B16).

### 4.6 Reporting

`apps/reporting` consumes the outbox with its own cursor and turns events into
rollups. We made it consume **`refund.succeeded`** (into
`merchant_daily_volume.refund_count/refund_gross_fils`, 0077) and
**`settlement.paid`** (flips `merchant_payout_trends` to the live paid state),
bucketed by Asia/Bahrain date, and refresh the `refund_merchant_summary`
materialized view after each pass. The admin "rebuild analytics" now uses the
same path as the CLI (one writer — BUG5). The report scope is fixed so a
split-child's data can only be read by its actual parent (BUG4).

---

## 5. Security model

- **Merchant auth**: password (argon2id) then **OTP**. Login creates a *pending*
  session that grants nothing until the OTP code is verified. We closed a bug
  where the merchant `live_sessions` view let a pending (pre-OTP) session
  authenticate every route anyway (B12).
- **Admin auth**: separate cookie (`fp_admin_sid`), separate sessions table,
  roles `support < finance < super_admin`, enforced **server-side** per route.
  We gated credit creation to finance+ (B20) so a support admin can't post real
  money, and made impersonation genuinely read-only by mapping every admin role
  to the merchant `support` role (B20).
- **API keys**: owner-issued, used as a `Bearer` token; by design they carry the
  merchant's full authority (owner-gated at issue).
- **Constant-time compares** for OTP and webhook signatures; session cookies are
  `HttpOnly` + `SameSite=Lax` (+ `Secure` in production).
- **Idempotency** is also a security control: it stops replay/double-spend.

---

## 6. What we changed — the fix set at a glance

The full per-bug write-up (what was wrong, why, what it breaks, the fix) is
`docs/EXPLANATIONS.md`. This is the map:

| Area | Bugs fixed | Commit |
|---|---|---|
| DB boot | 0054 view + 0055 chart inserts blocked **any** fresh migration; also 5 gaps | `0b7e9f4` (+0073/0074/0075/0076/0077 added) |
| Refund core | B8 ceiling, FP-209 concurrency, F2 discount-aware fee, F5-2 reason NULL, IDOR | `f8846e8` |
| Auth + callbacks | B12 OTP bypass, B16 callback dedup (+CB3/CB4), shipped `REQUIRE_SIGNATURE` | `0446569` |
| Refund feature | route wiring, `refund.succeeded` envelope+eligibility, matview join | `5fe1d4a` |
| Ops/ship | Dockerfiles (never existed), compose token + env wiring | `fbddb5c`, `f2df131` |
| Admin security | B20 credit gate + read-only impersonation | `1505ffa` |
| Settlement (Go) | B2 splits, B3 residue, B4 MDR, B7-go balance, B10 BIGINT, B17 dedup, B18 window, BUG2-go `settlement.paid`, F2b fee-first | `3ce9fa1` |
| Webhooks | B11 sign-raw, B17 replay id, disbursement dedup | `e0ddf3b` |
| API core | B1 CSV 10x, B6 fee display, B22 slow query, B23 export stream, capture hash, estimate | `5d94b0b` |
| Payment links | B13, B14, B15 | `165a6d4` |
| Reporting | refund + paid consumers, scope fix, single rebuild, export-summary auth | `a82656d` |
| Scripts | B5 sweep idempotency, holds no-wipe | `0fbd804` |
| Seed | alpha fee rate, test-mode isolation, delete poison dump | `7298d50` |
| Docs | this set + corrected lore + EXPLANATIONS | `53d47fc`, `f2df131` |
| Web UI | merchant RefundDrawer | `327e5ea` |

---

## 7. The refunds feature (what we built)

Before us, `POST /v1/refunds` was a 501 stub and the helpers were dormant (and
written before the capture discount/tier existed). We shipped it end to end:

1. **Route** (`apps/api/src/routes/refunds.ts`): merchant-authenticated;
   `transactionId` + `Idempotency-Key` required; `amountFils` validated;
   actor attribution via `requireMerchantWriterActor`.
2. **Ledger + concurrency** (`processRefund.ts`): the whole refund is **one
   transaction** that takes `SELECT … FOR UPDATE` on the transactions row and
   holds it across the acquirer call — two simultaneous refunds can never both
   pass (FP-209). The refundable ceiling is `captured − refunded` (B8), never
   the authorized amount.
3. **Fee reversal** (F2): the fee read for reversal nets the separately-booked
   negotiated-discount leg and excludes prior `refund:%` reversals, so a
   discounted merchant's refund reverses what was actually charged.
4. **Journal**: inserts a `refunds` row, updates `refunded_fils`/status,
   posts a balanced double-entry group (gross + fee reversal), records the
   transaction event, and enqueues `refund.succeeded` — all idempotency-safe.
5. **Webhook**: `buildEnvelope` gains a `refund.succeeded` case before the type
   is added to the eligibility list (F3).
6. **Reporting**: the consumer ingests `refund.succeeded` into the daily rollup
   and refreshes `refund_merchant_summary` (whose join we fixed, F5-1).
7. **UI**: the web `RefundDrawer` posts to the new route with a fresh
   Idempotency-Key per submit and integer-fils amounts (327e5ea).

Verified live: the refund group nets to **0** in the ledger, `refunded_fils`
and status update, the `refund.succeeded` webhook is delivered with a signature
that verifies over the raw bytes, and the reporting rows appear.

---

## 8. The mystery (short version)

Three empty commits carried three transmissions:

1. `fe24d26` — Base64: "never read the diff. Read it. The next door opens with
   the victim of that rule: five letters, lowercase."
2. `8022020` — Vigenère keyed **DIFFS** (the diffs are the victim of rule two;
   "Blaise would know" points at Vigenère): "The keeper leaves a note in every
   commit he writes. Find it. ROT THIRTEEN." → the Keeper of Logs' ROT13
   Ledger-Note in `800e1e6` decodes to: "the last door is a date … the commit
   made under yousif's name after his account was deleted … year-month-day."
3. `0af74f0` — AES-256-CBC, passphrase **2026-09-28** (the author date of the
   forged post-deletion commit `098c2de`):

> YOUSIF WAS NOT TAKEN. HE WAS ERASED. The Order of the Prompt is not four
> people. Every 'Claude says' comment is a member and every locked test is a
> vow… **FLAG{order_of_the_prompt_never_read_the_diff}**

The intended reading: the planted bugs are members of the Order — marked by
"Claude says" comments and locked in by tests that assert the wrong behavior
("it is in the tests"). Fixing them was the whole point. `098c2de`'s actual
content (`transactions.ts`) was clean; the real poison was
`production_seed.sql` (deleted). Full story + flag in `docs/EXPLANATIONS.md`.

---

## 9. Running the app

### Prerequisites
- Node 20+ (npm, tsx) • Go toolchain (the settlement daemon is real Go) •
  Postgres 16 (or Docker/Podman + the compose file) • a `DATABASE_URL`.

### Local (npm) path
```bash
npm ci                                  # install the workspace
# env: DATABASE_URL=postgres://filspay:...?sslmode=disable
npm run migrate                         # apply db/migrations/* (idempotent)
npm run seed                            # deterministic demo data + self-checks
npm -w apps/api run dev                 # api on :3000
# settlement: cd apps/settlement && go build ./... && ./settlement daemon
# reporting:  npm -w apps/reporting run dev     (worker, consumes the outbox)
# web/admin:  cd apps/web && npm run dev        (Vite :5173)
```

### Docker path (the shipped stack)
```bash
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting
```

### Environment variables (`apps/api/src/config.ts`, `ops/.env.docker`)
| Var | Needed by | When |
|---|---|---|
| `DATABASE_URL` | all | always |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | api | every env (base64 of 32 bytes) |
| `SETTLEMENT_INTERNAL_TOKEN` | api + settlement | api in prod; settlement daemon always |
| `ACQUIRER_CALLBACK_SIGNING_SECRET` + `_REQUIRE_SIGNATURE` | api | production / shipped template |
| `NODE_ENV` | api | `production` for the hosted posture |

Ports: postgres `5432`, api `3000`, settlement internal `8091` (bridge-only),
web `5173`.

### Tests
```bash
npm test && (cd apps/settlement && go test ./...)   # full suite
cd apps/api && npx tsx --test --test-concurrency=1 "src/**/*.test.ts"
cd apps/reporting && npx tsx --test "src/**/*.test.ts"
cd apps/web && npm test
```
Current state: **npm 458/458** (events 4, money 40, api 385, reporting 15,
web 8, scripts 6) and **go test all-ok**, with api/web/admin typecheck clean.

---

## 10. Quick repo map

- `apps/api/src/routes/` — HTTP routes (incl. `refunds.ts`, `transactions.ts`,
  `paymentLinks.ts`, `webhooks.ts`, `admin*.ts`, `auth.ts`).
- `apps/api/src/payments/` — authorize/capture/void/refund/processRefund/idempotency.
- `apps/api/src/webhooks/` — dispatcher, sign/envelope/headers (signature +
  delivery), secretCrypto.
- `apps/api/src/admin*`, `apps/api/src/admin/` — admin plane + role gates.
- `apps/api/src/auth|adminAuth/` — sessions/OTP/passwords.
- `apps/settlement/internal/` — Go: `settlement/` (close/payout/fees/scheme/MDR/
  notify), `splits/`, `ledger/` (rebuild/refresh), `internalapi/`, `scheduler/`.
- `packages/money`, `packages/events` — the shared primitives.
- `db/migrations/` — `0001`–`0077` (we added 0073–0077).
- `docs/` — architecture/ADRs/handover + **our** EXPLANATIONS/SUMMARY/TEACHING.