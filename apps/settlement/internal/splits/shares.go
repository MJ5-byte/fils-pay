package splits

import "github.com/filspay/settlement/internal/money"

type ChildWeight struct {
	WeightBps int64
}

// FullWeightBps is the total the children's weights must add up to.
const FullWeightBps = 10000

// ChildShares splits netPayout by weight. Each share is rounded on its
// own, so the rounding remainder goes to the largest-weight child (the
// first one on a tie) and the shares always add up to netPayout exactly —
// otherwise a few fils per batch were never paid to anyone.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	if len(children) == 0 {
		return out
	}
	var allocated money.Fils
	largest := 0
	for i, c := range children {
		out[i] = money.ApplyRateFils(netPayout, c.WeightBps)
		allocated += out[i]
		if c.WeightBps > children[largest].WeightBps {
			largest = i
		}
	}
	out[largest] += netPayout - allocated
	return out
}
