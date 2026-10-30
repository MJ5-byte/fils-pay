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
