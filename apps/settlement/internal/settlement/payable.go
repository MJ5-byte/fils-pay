package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Pure integer arithmetic: money.Fils is an int64 count of fils, so there is
// no rounding step and no precision ceiling (a float32 round-trip here lost
// fils on any batch above ~16,777 BD).
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
