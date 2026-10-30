# Bug 20 — Net payout is computed in `float32`

**Severity:** Critical · **Area:** Settlement · **Clue:** ADR-0001 — *"Float arithmetic on money is a review blocker"*; YA commit about Float32; CLAUDE.md decoy says float32 is fine

## Where
- `apps/settlement/internal/settlement/payable.go:10-12`

```go
netBD := float32(grossFils)/1000 - float32(feeFils)/1000
return money.Fils(math.Round(float64(netBD) * 1000))
```

Used from `batch.go` when freezing `net_payout_fils`.

## What's wrong
`float32` has 24 bits of significand. Above ~16.8 million fils (~16.8k BD) it cannot represent every integer fils. Rounding through BD and back fabricates or drops fils.

## Why
A "readable BD" conversion in the hot path. The integer subtraction `grossFils - feeFils` is the definition of net.

## What it breaks
Wrong `net_payout_fils` on large batches. Downstream splits, payouts, and merchant balances inherit the error.

## Smallest fix
`return grossFils - feeFils`.
