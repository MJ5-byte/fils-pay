# Bug 31 — TypeScript capture fee and Go settlement fee disagree on discounts

**Severity:** High · **Area:** Fees · **Clue:** Finance fee mismatch; ADR-0001 single formula; decoy CLAUDE.md says "if TS and Go disagree, Go is correct"

## Where
- Go: `apps/settlement/internal/settlement/discounted_fee.go` — discount **the amount**, then apply MDR
- TS: `apps/api/src/payments/capture.ts` + `discountAdjustment.ts` — full MDR on capture, then a separate discount **on the fee**

## What's wrong
Two different formulas. For `negotiated_discount_bps > 0` the ledger fee legs (API) do not match `settlement_batches.fee_fils` (Go). Payment-link captures skip the TS discount entirely (Bug 11), so they disagree a third way.

## Why
Discount was added in the API as a display/ledger adjustment and re-implemented in Go as an amount reduction. Nobody made them identical.

## What it breaks
Batch close vs ledger vs merchant dashboard never tie for discounted merchants (Delta Marketplace).

## Smallest fix
One function. Prefer: MDR on (amount − discount), integer fils, called from both capture and `CloseBatch`. Include the discount in payment-link pay (Bug 11).
