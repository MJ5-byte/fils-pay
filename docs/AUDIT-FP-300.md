# FP-300 audit: what was wrong and what changed

## Refunds (FP-212 / FP-300 / FP-209)
- `POST /v1/refunds` and `POST /v1/merchants/:id/refunds` are live; both share one path.
- Refundable amount is `captured - refunded - pending`, not the authorized amount.
- The transaction row is locked (`FOR UPDATE`) and the amount is reserved in a
  `pending` refund row (migration 0073) before the acquirer call, so concurrent
  refunds cannot both pay out.
- A merchant can only refund its own transactions (the entry point previously
  looked a transaction up by id alone and refunded it as its real owner).
- `reason` is never inserted as NULL (it broke migration 0070's CHECK).
- Fee reversal uses the net fee kept after the negotiated discount, and the
  refund that completes the capture reverses the exact remainder.
- Status follows finance's rule: `refunded` when every captured fil went back.
- `refund.succeeded` is delivered to merchant webhooks.
- Dashboard `RefundDrawer` restored; `refundedFils` is now on the transaction DTO.

## Payment links (FP-187 / FP-198)
- The public pay route ignores buyer-supplied `submittedAt` for expiry.
- A reservation token ties finalize/release to the attempt that holds the link.
  If a slow attempt loses its reservation after the card was charged, it is
  refunded automatically instead of answering "paid".
- Cancel is scoped to the caller's merchant.

## Webhooks and callbacks (FP-240)
- The dispatcher signs exactly the bytes it sends.
- Acquirer callbacks are de-duplicated on `callback_id` (migration 0074;
  `processed_events` never existed). Signatures are required by default in production.

## Money
- Adjustment CSV amounts use `parseBhdToFils` (and the tests that expected the
  10x-wrong values were corrected). Promotional discounts no longer use `parseFloat * 100`.
- Go: `NetPayableFils` is integer; split payouts use largest-remainder so child
  shares sum to the batch payout; MDR recalculation no longer rewrites paid batches;
  the admin "rebuild balances" reads the ledger like the CLI; the daemon derives
  "today" from the Bahrain calendar date. **These Go changes could not be compiled
  or tested in the audit environment (module downloads blocked) - run
  `cd apps/settlement && go test -short ./...` before shipping.**

## Security
- OTP, payment-link token and invite codes use `node:crypto`.
- Admin impersonation can no longer capture, void, or refund.
- `ops/.env.docker` (tracked) contains a secret; rotate it.

## Tests
- The webhook backoff test asserted an exact delay against randomly jittered code; it now fixes the jitter.
- Reporting tests share one database with the API tests; run them against a fresh migrated database (they pass there).

## Migrations
- 0054 no longer references the nonexistent `settlement_batch_events`.
- 0055 uses the real `chart_of_accounts` columns.
- 0072 joins refunds to transactions on `transaction_id`.

## Not done / open
- Scheme residue posting (ADR-0002) and the `refund_merchant_summary.original_captured_fils`
  double count across multiple refunds.
- `merchant_payable_position` (view) is no longer used by the balance rebuild; remove or fix it.
- Stale `pending` refunds (process crash between reserve and settle) need a reaper.

---

# Round 2 (30 Oct): open items closed

Each fix is the smallest change that works, has a test that fails on the old
code, and runs against a real migrated Postgres. Verified: API 377/377,
settlement `go test ./...` all packages, scripts 5/5, reporting 11/11 (on a
fresh database; the reporting tests share tables with the API tests).

## Login works without the OTP code (finance memo; "is OTP still safe?")
- **What:** after `POST /v1/auth/login` (password only), the pending-session
  cookie already worked on every merchant endpoint. OTP verify was optional.
- **Why:** `lookupSession` reads the `live_sessions` view (0058), which filters
  revoked and expired rows but not `authenticated`. Pending sessions (created
  with `authenticated = false`) therefore resolved like real ones. The admin
  plane checks `authenticated = true` explicitly; the merchant plane never did.
- **Breaks:** the second factor entirely. A stolen password is a full login.
- **Fix:** `AND s.authenticated = true` in `lookupSession` (`auth/sessions.ts`).

## Login can land in another merchant's account
- **What:** with one email under two merchants, logging in to merchant B with
  B's password could produce a session for the user in merchant A.
- **Why:** after checking the password for the exact (merchantId, email) row,
  login called `findOtpRecipient(email)`, which picks *any* active merchant
  user with that email (`LIMIT 1`, no merchant filter), and created the
  session for that row. Emails are unique per merchant, not globally, and
  public signup lets anyone register a merchant with someone else's email.
- **Breaks:** tenant isolation: one merchant's credentials open another's
  dashboard, money and refunds.
- **Fix:** the session is created for the row whose password was checked
  (`routes/auth.ts`).

## API key rotation leaves the old key working (handwritten note)
- **What:** an admin "rotate" issued a new key; the old one kept authenticating.
- **Why:** `rotateApiKeyAsAdmin` locked the old row and issued the new key but
  never set `revoked_at`. Migration 0037 and the route comment both say
  rotation revokes with reason `'rotated'`; a test had been written to assert
  the bug ("grace period", which no doc defines).
- **Breaks:** rotating a leaked key does nothing.
- **Fix:** revoke the old key, `revoked_reason = 'rotated'`, in the same transaction.

## Duplicate payout notifications (incident 2026-08-21)
- **What:** shops got two "your payout is on the way" webhooks for one payout.
- **Why:** `EnqueuePayoutNotifications` checks `NOT EXISTS` and then `INSERT`s as
  two statements with no lock. The daemon tick and a CLI `run-batch` that
  overlap both pass the check and both insert. The CHANGELOG 1.9.1 "fix" only
  told receivers to dedupe.
- **Breaks:** duplicate merchant notifications and duplicate webhook deliveries.
- **Fix:** migration 0076 adds a partial unique index (one `settlement.paid`
  per batch; existing duplicates are relabelled because deliveries reference
  them), and the insert uses `ON CONFLICT DO NOTHING`. New test runs 8
  enqueuers concurrently and gets exactly one event.

## Dashboard shows 245 bps, payments charged at 225 (finance memo)
- **Why:** the display query ordered fee schedules by `created_at` ("most
  recently entered"); billing (`getEffectiveMdrBps`) uses the latest
  `effective_from <= now()`. A backdated correction entered later won the
  display while billing used the newer rate. A test asserted the 245.
- **Breaks:** support quotes the wrong fee; merchants dispute charges.
- **Fix:** the display uses billing's rule (`fees/currentFeeScheduleDisplay.ts`).

## March sweep script is not safe to re-run (finance memo)
- **Why:** the comment said "entry_group_id dedupes it", but `entry_group_id`
  is a fresh `randomUUID()` per run, so a second run posted every merchant's
  residue again (the doubled gap on staging).
- **Fix:** inside the transaction, take an advisory lock and refuse if the
  sweep's ledger entries already exist (`scripts/reconcile_march.ts`).

## Large export ("has anyone tried a really large export?")
- **Why:** `/v1/transactions/export` loaded every row and joined one big string
  in memory despite the CHANGELOG saying it streams; the streaming function
  existed but was unused, and it paged on `occurred_at > last` only, which
  skipped every row sharing a timestamp with a page boundary.
- **Breaks:** a big merchant's export can exhaust the 512 MB container; the
  streamed version would silently drop rows.
- **Fix:** the route streams; paging is keyset on `(occurred_at, id)`.

## Refund report double counts captured amounts (FP-300 "reports")
- **Why:** `refund_merchant_summary` (0072) summed `t.captured_fils` once per
  refund row, so a payment refunded in two parts showed its capture twice.
- **Fix:** migration 0077 aggregates per transaction first.

## Lifetime payout estimate drifts; volume tier can switch itself off (finance memo)
- **Why:** `lifetime_net_payout_monitoring_estimate` was `REAL` written from
  Go `float32`: exact only to 2^24 fils (~16,777 BD), then every add rounds,
  so high-volume merchants drift. Separately `platform_stats.total_processed_fils`
  was `INTEGER` with Go `int32` while the tier threshold is 2,000,000,000: past
  ~2.1M BD the Go addition wraps negative and the 15 bps discount turns off
  for everyone. (A code comment claimed the column was BIGINT; it wasn't.)
- **Fix:** migration 0078 makes both BIGINT; Go uses int64; the API reads the
  BIGINT (a string from pg) with `Number()`.

## Earlier Go fixes now actually tested
The round-1 Go fixes (splits, MDR recalculation, Bahrain business date,
balance rebuild) had never been compiled. They now pass `go test` against
Postgres. Two balance-refresh tests still seeded scheme export lines (the old,
wrong source for the admin button, FP-203); they now seed the ledger.

## Still open
- Scheme rounding residue posting (ADR-0002): the "always a few fils over" statement gap.
- `OTP_DEV_EXPOSE=true` in the hosted environment shows the OTP on the login page; needs real OTP delivery first.
- No rate limit on OTP verify/resend; admin session token not rotated after OTP (FP-198).
- Stale `pending` refunds need a reaper.
- Not reviewed: slow reporting query, test merchants under admin tools, inbound callback signature details.
