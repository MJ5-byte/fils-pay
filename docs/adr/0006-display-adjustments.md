# 0006. Adjustments are display corrections, not postings

- **Status:** Superseded by 0008
- **Date:** 2026-05-04
- **Deciders:** Mahmood Khalil, support lead
- **Related:** FP-203, `apps/api/src/admin/balanceAdjustments.ts`

## Context

Support regularly needs to correct the balance a merchant sees on the
dashboard after a phone call or a statement query. Posting a ledger entry
for each of these needs finance approval, a counter-account and a reason
code, and takes days. Most corrections are for display drift, not for money
that actually moved.

## Decision

**Adjust balance** in the console writes `merchant_balances` directly:

- `cached_payable_fils = cached_payable_fils + delta`
- an audit row (`balance_adjustment`) with before/after and the reason
- no ledger entry

A journaled variant (`adjustMerchantBalanceJournaled`) exists for cases
where finance has approved a real money correction. It is not exposed in the
UI yet.

## Consequences

- Corrections appear on the dashboard immediately.
- The ledger, statements and settlement are not affected by display
  corrections.
- A balance rebuild resets the cache, so corrections must be re-applied
  after a rebuild. Support's workflow is Rebuild, then Adjust.
