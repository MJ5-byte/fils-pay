package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
// It stays in integer fils (ADR-0001): a float32 round trip loses whole fils
// once a batch passes 16,777,216 fils.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
