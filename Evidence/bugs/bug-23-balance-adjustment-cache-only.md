# Bug 23 — Admin "Adjust balance" writes the cache only, not the ledger

**Severity:** High · **Area:** Admin / ledger · **Clue:** Related to FP-203; ADR-0004 even admits adjustments are cache-only; ADR-0006 says adjustments are display corrections — but finance CSV is supposed to move money

## Where
- `apps/api/src/routes/adminBalanceAdjustments.ts` — calls `applyBalanceCorrection`
- `apps/api/src/admin/balanceAdjustments.ts` — cache + audit UPDATE; a journaled variant exists in the same file and is not routed

## What's wrong
The production route changes `merchant_balances.cached_payable_fils` and writes an audit row. No `ledger_entries`. The next real rebuild (CLI, or a fixed button) overwrites the adjustment. The journaled helper is dead code.

## Why
Cache was treated as source of truth because the button already diverged (Bug 22).

## What it breaks
"Corrections" vanish. Audit says money moved; the ledger says it did not.

## Smallest fix
Route POST to `adjustMerchantBalanceJournaled`. Rebuild always from the ledger.
