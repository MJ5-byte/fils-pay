# 0008. Adjustments post to the ledger

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** Yusuf Mohamed, Moataz Osama
- **Supersedes:** ADR-0006
- **Related:** BHA-192, BHA-189, BHA-191, ADR-0007

## Context

ADR-0006 made admin balance adjustments cache-only corrections. Every
balance rebuild erased them because they had no ledger postings. A balance
correction is money owed to or by the merchant, so it belongs in the ledger
and in a payout.

Under the ADR-0007 amendment, `merchant_balances.cached_payable_fils` holds
closed, unpaid batch nets. Writing an adjustment to the cache at posting
would count it again when its batch closes.

## Decision

Admin balance adjustments and the CSV import post balanced integer fils
legs through `postLedgerAdjustment`, using `manual_balance_adjustment_contra`
against `merchant_payable`. Neither posting path writes the payable cache.
The admin route locks the merchant row and retains its response shape. Its
before and after values are the same cache value, or zero when no cache row exists.

- A positive adjustment above `CREDIT_APPROVAL_THRESHOLD_FILS` (50.000 BD) is refused with `adjustment_needs_second_approver`, on the route and on each import row, because it would be paid at the next close on one approver. Finance posts it as a manual credit, which has the second approver. Debits are not limited.

`CloseBatch` claims unbatched `merchant_payable` adjustment legs posted
before the business day's end, with no lower date bound. Credits join gross
with no fee, like posted manual credits. Debits reduce gross after refunds,
oldest first. A debit that would make net negative stays unclaimed and
carries forward, because a negative batch has no payout leg to recover the
money. Claimed legs receive the batch id in the transaction that freezes
its totals, so a later close cannot count them again. Adjustments do not
count toward processed card volume.

The cache receives the batch net through `balances.ApplyBatchClose` at
close. Rebuilding from closed, unpaid batch nets therefore preserves the
same payable amount.

## Consequences

The payable shown moves at settlement close, not at adjustment time. The
admin notice explains this timing. Adjustment legs posted before this
change are claimed by the next eligible close.

`adjustMerchantBalanceJournaled` has no caller outside its own tests. It
still writes the cache and is left unchanged; removing or changing it
requires a separate decision.
