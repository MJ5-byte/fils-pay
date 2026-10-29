package settlement

import "github.com/filspay/settlement/internal/money"

// ComputeSettlementFee computes the platform fee owed on one capture event,
// net of any negotiated per-merchant discount: the MDR fee is computed on
// the full amount first, then the discount rate is applied to that fee
// itself. Discounting the amount before charging MDR can round an entire
// small fee away (e.g. 23 fils at 225bps MDR / 500bps discount -> 0) and
// diverges from the API fee preview.
func ComputeSettlementFee(amountFils money.Fils, mdrBasisPoints, discountBasisPoints int64) money.Fils {
	fee := money.ApplyRateFils(amountFils, mdrBasisPoints)
	return fee - money.ApplyRateFils(fee, discountBasisPoints)
}
