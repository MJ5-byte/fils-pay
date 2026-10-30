package settlement

import "github.com/filspay/settlement/internal/money"

// ComputeSettlementFee computes the platform fee owed on one capture event,
// net of any negotiated per-merchant discount. It prices the way the ledger
// already does: capture.ts posts the MDR fee on the amount, then
// discountAdjustment.ts rebates the discount off that fee, each with one
// ApplyRateFils rounding (ADR-0001). Discounting the amount first lands a
// fil away at some amounts, so a batch priced here would not match what the
// merchant was charged at capture.
func ComputeSettlementFee(amountFils money.Fils, mdrBasisPoints, discountBasisPoints int64) money.Fils {
	fee := money.ApplyRateFils(amountFils, mdrBasisPoints)
	return fee - money.ApplyRateFils(fee, discountBasisPoints)
}
