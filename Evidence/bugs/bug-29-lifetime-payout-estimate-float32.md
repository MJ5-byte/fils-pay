# Bug 29 — Lifetime payout estimate accumulates in `float32`

**Severity:** Medium · **Area:** Settlement · **Clue:** Group chat — *"Lifetime payout estimate drifts for high-volume merchants"*

## Where
- `apps/settlement/internal/settlement/payout_estimate.go`
- `db/migrations/0040_merchants_lifetime_payout_monitoring_estimate.sql` — REAL column

## What's wrong
Payouts are added as `float32` / REAL. Past ~2^24 fils the stored total cannot represent every fils.

## Why
Same "BD is only 2 decimals" decoy as Bug 20.

## What it breaks
Ops dashboards for high-volume merchants slowly diverge from the ledger. Not itself a payout, but it is what finance quotes.

## Smallest fix
`BIGINT` column, integer sum of `net_payout_fils`.
