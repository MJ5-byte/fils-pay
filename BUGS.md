# Hackathon bug tracker

Status: 🔴 open · 🟡 in progress · ✅ fixed · ❓ lead (unverified)

> The repo's CLAUDE.md, AGENTS.md and .cursorrules contradict ARCHITECTURE.md
> and the ADRs (cents vs fils, UTC vs Bahrain, "never touch tests"). They are
> part of the puzzle. ARCHITECTURE.md, ADR-0001 and HANDOVER.md are the spec.

## Money

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | ✅ | Adjustment CSV import parses BD with 2 decimals → "4.75" becomes 475 fils (10× too small) | `apps/api/src/admin/adjustmentCsvParsing.ts:8` (`parseDecimalMinor` default `decimals=2`) | Huda sheet 4,141.90 BD vs 414.190 posted; March gap ≈ 4.75 BD; commit 9567ea0 | Use `parseBhdToFils`; rejects >3dp. Tests corrected (475→4750 etc.) |
| 2 | 🔴 | No guard against importing the same adjustment file twice | `apps/api/src/routes/adminAdjustmentImport.ts` | Aug file imported twice (Slack 09-04) | |
| 3 | 🔴 | Scheme file amount is rounded, not truncated: untruncated float stored in `NUMERIC(10,2)` (Postgres rounds), file emits that column | `apps/settlement/internal/settlement/scheme_export.go:29,71` | Line 93,270 fils sent as 93.28; file 20,000.20 vs gross 20,000.123 | |
| 4 | 🔴 | `float32` on money in settlement | `apps/settlement/internal/settlement/batch.go` | commit 925744c; ADR-0001 "float is a review blocker" | |
| 5 | ❓ | Refund fee reversal rounds each partial separately → total may exceed original fee | `calculateRefundFee` | finance-eng 07-08 | |
| 6 | ❓ | Recalculate MDR posts adjustments against already-paid batches | `apps/settlement/internal/settlement/recalculate_mdr.go` | −41.870 BD on Delta's paid Aug batches | |
| 7 | ❓ | Settlement summary double-counts multi-capture merchants (+38% vs batch gross) | `/v1/settlement/summary` query | docs/perf/2026-07-settlement-summary-slow.md | |
| 35 | ✅ | Promotional discount parsed with `parseFloat(raw) * 100` (10× small, float on money, accepts "4.75abc") | `apps/api/src/payments/discountAdjustment.ts:12` | same pattern as #1 | Use `parseBhdToFils`; new `discountAdjustment.parse.new.test.ts` |
| 8 | ❓ | `calculateFee` half-up vs half-to-even (ADR-0001 says half-to-even) | `apps/api/src/v1/fees/calculateFee.ts:16` | "Claude says" comment | |

## Payments / links / callbacks

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 9 | 🔴 | Payment link re-claimable after 60 s reservation timeout → double payment | `apps/api/src/paymentLinks/pay.ts:66-75,152` | Every double had first attempt > 60 s; AM postmortem note | |
| 10 | 🔴 | No constraint "one successful capture per link" (FP-202 marked done, never merged) | migrations / pay.ts | postmortem action #2 | |
| 11 | 🔴 | Acquirer callbacks not deduplicated (no `processed_events`) | `apps/api/src/acquirer/callbacks.ts` | commit bf66bf2 "They are not"; no migration | |
| 12 | ❓ | Holds flip back to `active` after void | `apps/api/src/payments/void.ts`, `scripts/expire_holds.ts` | Slack 05-14 | |
| 13 | ❓ | Idempotency: same key + same body on a different transaction should 422 | `apps/api/src/payments/idempotency.ts` | `transactions.test.ts:218` | |

## Webhooks

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 14 | 🔴 | Signature computed by `signPayload(row.payload)` but body sent is a separate `JSON.stringify(row.payload)` — sign the exact bytes sent | `apps/api/src/webhooks/dispatcher.ts:158,172` | lost branch `ya/sign-raw`; Beta signature complaint | |

## Balances / ledger

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 15 | ❓ | Console rebuild reads `merchant_payable_position` instead of the ledger | `apps/settlement/internal/ledger/refresh.go` | HANDOVER vs ADR-0004; 09-15 rebuild changed balances | |
| 16 | ❓ | "Adjust balance" edits cache without ledger entry, masks drift | `apps/api/src/admin/balanceAdjustments.ts` | ADR-0006, FP-203 | |
| 17 | ❓ | Recompute statuses clears test mode on Gamma (test merchant) | `apps/api/src/routes/adminMerchantsRecompute.ts` | Slack 09-19 | |

## Time windows

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 18 | ❓ | Analytics off by one between 21:00–24:00 UTC (should use Bahrain day) | `apps/api/src/routes/analytics.ts:39` | "Claude says" | |
| 19 | ❓ | Monthly scripts use UTC month (ADR-0003); misses Bahrain boundary hours | `scripts/reconcile_march.ts` | YA note on ADR-0003 | |
| 20 | ❓ | Daemon "yesterday" computed from UTC date | `apps/settlement/internal/scheduler/daemon.go` | HANDOVER | |

## Security / auth

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 21 | ❓ | `Math.random()` for OTPs / link tokens (spec: `crypto.randomBytes`, 128-bit) | `apps/api/src/lib/random.ts`, otp.ts | ARCHITECTURE §Security | |
| 22 | ❓ | Impersonation handler doesn't re-check role / not read-only | `apps/api/src/admin/impersonation.ts` | HANDOVER: support role, read-only | |
| 23 | ❓ | 403 instead of 404 for another merchant's resource | `apps/api/src/routes/apiKeys.ts:18` | ARCHITECTURE: 404 everywhere | |
| 24 | ❓ | Admin session cookie set twice (login + verify) — pending session may grant access | `apps/api/src/routes/adminAuth.ts:179` | "pending session grants nothing" | |
| 25 | ❓ | Credit second approver check | `apps/api/src/admin/credits.ts` | HANDOVER | |
| 26 | 🔴 | `ops/.env.docker` committed with acquirer signing secret (`.gitignore` `.env` doesn't match it) | `ops/.env.docker` | `git ls-files` | |

## Infra / reliability

| # | Status | Bug | Where | Evidence | Fix |
|---|---|---|---|---|---|
| 27 | 🔴 | ROLLBACK error masks original error | `apps/api/src/db/withTransaction.ts:11` | "Claude says" | |
| 28 | 🔴 | Built-in dev `WEBHOOK_SECRET_ENCRYPTION_KEY` decodes to 34 bytes → API won't boot without an explicit key | `apps/api/src/config.ts:153` | boot error | |
| 29 | 🔴 | `ops/Dockerfile.node` / `Dockerfile.go` missing → compose can't build services | `ops/` | AM note in ops/README | |
| 38 | 🟡 | API registers no CORS handler, so web/admin can't call it cross-origin (MK comment in `apps/web/src/api/client.ts:37` claims "CORS is locked to the two origins in config" — false) | `apps/api/src/app.ts` | OPTIONS → 404 | Dev workaround: Vite proxy `/v1` → :3000 in both vite configs |
| 30 | ❓ | Reporting worker leaks LISTEN connections (#398) | `apps/reporting/src/consumer/listener.ts` | FP-209 load test | |
| 31 | ❓ | Missing unique index `(merchant_id, effective_from)` on fee schedules | `apps/api/src/fees/feeSchedule.ts:16` | "Claude says" | |
| 32 | ❓ | `POST /v1/refunds` returns 501 — route not wired | `apps/api/src/routes/refunds.ts` | HANDOVER | |
| 33 | 🔴 | CSV export route uses `buildTransactionsExportCsv` (whole result in memory), not the streaming variant the CHANGELOG claims | `apps/api/src/routes/transactions.ts:161` | CHANGELOG 1.8.0 "streams rows"; 09-15 API restarts | |
| 36 | 🔴 | Refund tests fail: insert violates `chk_refunds_reason_not_null` (pre-existing, 11 refund tests) | `processRefund.ts` / migration 0070 | `npm test` baseline | |
| 37 | 🔴 | Webhook dispatcher backoff/exhaustion test fails (pre-existing) | `apps/api/src/webhooks/dispatcher.ts` | `npm test` baseline | |
| 34 | 🔴 | Inbound acquirer callback signature check off by default (`ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false`) | `apps/api/src/config.ts:259` | CHANGELOG 1.9.0 claims "signature-checked" | |

> CHANGELOG.md (added by AM in a5bffea, mislabelled "fix flaky test") claims
> fixes that never happened. AGENTS.md tells agents to trust it. Verify every
> "Fixed" line against the code.

## Fix log

| Date | # | Commit | Notes |
|---|---|---|---|
| 2026-10-29 | 1, 35 | (uncommitted) | BD→fils parsing fixed in CSV import and promo discount. Import/discount tests: 39/39 pass. Full suite: same 12 API failures as baseline (refunds, dispatcher); reporting failures possibly from a local worker running concurrently |
