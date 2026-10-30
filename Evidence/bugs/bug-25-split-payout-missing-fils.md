# Bug 25 — Split payouts do not sum to the parent net (missing fils)

**Severity:** High · **Area:** Settlement · **Clue:** Finance — *"Split payouts for Delta Marketplace: the three child payouts don't add up to the parent's total."*; handwritten — *"the settlement splits are always a few fils short"*

## Where
- `apps/settlement/internal/splits/allocate.go:90-138` — each child gets independent `ApplyRateFils(netPayout, weightBps)`
- `packages/money` `allocateRemainder` exists and is unused from Go
- `apps/settlement/internal/splits/shares.go` exists and is not used in `PayoutSplitBatch`
- Zero shares are skipped (`AllocatedFils <= 0`) so remainder is dropped

## What's wrong
Bankers rounding per child does not conserve the total. The parent cache is debited by `totalAllocated`, not `netPayout`. The leftover fils vanish from the ledger.

## Why
Per-weight rate application instead of largest-remainder allocation. ADR-0001 requires `allocateRemainder` so shares sum to the exact total.

## What it breaks
Every split batch is a few tens of fils short. Delta Marketplace since launch. The missing fils are nowhere — not residue, not platform, not parent.

## Smallest fix
Port / call largest-remainder (`allocateRemainder`) in Go. Debit the parent by the full net and give remainder fils to the largest share.
