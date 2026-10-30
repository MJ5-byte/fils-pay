# Bug 24 — MDR recalculation rewrites batches that are already paid

**Severity:** High · **Area:** Settlement · **Clue:** Finance — *"MDR recalculation changed batches that were already paid out. Those should never change."*

## Where
- `apps/settlement/internal/settlement/recalculate_mdr.go:63-112` — selects `status <> 'open'` (includes **paid** / **closed**), then `UPDATE settlement_batches SET fee_fils, net_payout_fils`

## What's wrong
Paid batch totals are mutable. Settlement team claimed it only touches open batches; the predicate is the opposite of open.

## Why
`<> 'open'` was used instead of `= 'closed'` (or "open only"). Paid rows are not frozen.

## What it breaks
Historical payouts no longer match what was actually disbursed. Reports and scheme vs ledger reconcilations rewrite themselves after the fact.

## Smallest fix
Restrict to `status = 'closed'` (unpaid), or insert an adjustment batch and never UPDATE a paid row.
