# 0007. Balance cache rebuild reads the ledger

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Moataz Osama
- **Supersedes:** the source choice in ADR-0004
- **Related:** BHA-9, FP-203, ADR-0004, ADR-0006, `docs/HANDOVER.md` "Balances"

## Context

ADR-0004 gave the console's "Rebuild cached balances" button its own source,
the `merchant_payable_position` view, because the ledger walk took about 40 s
cold in production and the API gives up on the call after 30 s
(`SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS`, default 30000). It also promised
that the button and the `settlement rebuild-balances` CLI agree whenever the
cache is consistent with settled activity.

That promise cannot hold with that source:

- The view is lifetime gross from `scheme_export_lines`. It has no fees, no
  payouts, no refunds and no manual credits, so it is not a balance. On our
  seeded data it put Alpha Retail at 7,326.770 BD against a ledger of
  136,496.486 BD.
- It never sees a capture that has not been exported yet, while the ledger
  credits `merchant_payable` at capture. The two differ for as long as any
  capture is unsettled.
- The view comes from migration 0054, which fails on a fresh chain
  (`settlement_batch_events` does not exist), so on a fresh database the
  button answered 500.
- `docs/HANDOVER.md` says the only rebuild is the CLI, which reads the
  ledger, and that there should be no button that reads anything else.

## Decision

The button calls the same function as the CLI, `ledger.RebuildAllBalances`,
which sums `merchant_payable` in `ledger_entries` per merchant. There is one
rebuild path and one source.

The rebuild takes `LOCK TABLE merchant_balances IN EXCLUSIVE MODE` as the
first lock of its transaction, before it reads the ledger. That blocks
every insert and update of the cache, including the first one for a merchant
that has no row yet, and every `SELECT ... FOR UPDATE` on it, which the admin
balance adjustment takes before it updates
(`apps/api/src/admin/balanceAdjustments.ts`); plain `SELECT`s still pass. A
weaker mode such as `SHARE ROW EXCLUSIVE` does not conflict with
`FOR UPDATE`, so an adjustment holding a row lock, the rebuild's write
waiting on that row, and the adjustment's update waiting on the table lock
would deadlock. A writer that got in first, such as a payout, a manual credit
or an adjustment, commits before the sum is read, so its ledger legs are
counted; one that starts later waits and applies its delta on top of the
rebuilt value. A batch close posts no ledger legs, so the rebuilt value
replaces its cache increment either way. Before this, a delta committed
between the sum and the write was lost. The lock is the first one the
rebuild takes, so it cannot deadlock with a writer, and two rebuilds run one
after the other. No foreign key references `merchant_balances`, so no write
to another table waits on this lock.

## The timeout

Measured on our seeded local database (283 merchants, 7,294 ledger rows),
the rebuild with the `EXCLUSIVE` table lock answered in 0.53 to 1.00 s
through the live internal endpoint (five calls).
The 40 s production figure could not be checked here.

The rebuild sets `lock_timeout = '5s'` for its transaction before it asks
for the table lock. A queued `EXCLUSIVE` request makes every later writer of
`merchant_balances` wait behind it, so a rebuild stuck behind a long
transaction would otherwise stall payouts and credits for as long as it
waited, up to the API's 30 s, and without limit from the CLI. After 5 s it
gives up with "merchant_balances is busy, lock not granted within 5s,
nothing changed; try again" (SQLSTATE 55P03) and changes nothing; the button
answers 500 and can be pressed again.

If a rebuild does run past 30 s, the API aborts the call and closes the
connection. The settlement handler reads the request body to the end before
it starts (a body over 1 KiB, or one cut short, gets a 400 instead, since it
can never be read to the end), which is what lets Go's `net/http` notice the
closed connection and cancel the request context; pgx then cancels the query
and the transaction rolls back, so the cache is left as it was, never half rebuilt,
and the API's audit row saying the rebuild failed is true. Without that read
the rebuild ran on and committed after the API had reported a failure.
If that starts to happen, the next step is one grouped `SUM ... GROUP BY
merchant_id` in place of one query per merchant, not a different source.

## Consequences

- The button and the CLI always write the same figure, the ledger sum.
- While a rebuild runs, every write to `merchant_balances` (batch closes,
  payouts, credits, adjustments) and every `SELECT ... FOR UPDATE` on it
  waits for it, for as long as it takes. Plain reads do not wait.
- Manual corrections made with **Adjust balance** are still cache-only
  (ADR-0006) and a rebuild still overwrites them, as before.
- The incremental path adds a batch's net payout to the cache at close
  (`balances.ApplyBatchClose`), while the ledger credits `merchant_payable` at
  capture. A rebuild therefore counts captures that are not closed yet, and
  their close adds them again. This was already true of the CLI and is not
  changed by this decision.
- `ledger.RefreshBalanceCache` and the `merchant_payable_position` view have
  no callers left. Whether they are removed is a separate decision.
