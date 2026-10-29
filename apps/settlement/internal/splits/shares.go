package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// AllocateRemainder splits total into len(weights) integer-fils shares
// proportional to weights, guaranteeing sum(shares) == total exactly, by
// the largest-remainder method: each share starts at
// floor(total*weight/sum(weights)), and the leftover fils (0 <= leftover <
// len(weights)) are distributed one each to the shares with the largest
// fractional remainders, ties broken by ascending index so the result is
// deterministic. This is the Go port of packages/money/src/fils.ts's
// allocateRemainder, which enforces the same contract for the TS split
// path.
//
// Weights here are integer basis points (merchant_split_children.
// split_weight_bps), so no decimal scaling is needed. Panics on an empty
// weight set, any negative weight, or all-zero weights — the same
// degenerate inputs the TS side rejects, and the same panic style money.
// BankersRoundDiv uses for a zero denominator.
func AllocateRemainder(total money.Fils, weights []int64) []money.Fils {
	if len(weights) == 0 {
		panic("splits: AllocateRemainder: weights must not be empty")
	}
	var weightSum int64
	for _, w := range weights {
		if w < 0 {
			panic("splits: AllocateRemainder: weights must be non-negative")
		}
		weightSum += w
	}
	if weightSum == 0 {
		panic("splits: AllocateRemainder: weights must not all be zero")
	}

	shares := make([]money.Fils, len(weights))
	remainders := make([]int64, len(weights))
	var allocated int64
	for i, w := range weights {
		product := int64(total) * w
		base := product / weightSum
		shares[i] = money.Fils(base)
		remainders[i] = product - base*weightSum
		allocated += base
	}

	leftover := int64(total) - allocated // 0 <= leftover < len(weights)
	order := make([]int, len(weights))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if remainders[ia] != remainders[ib] {
			return remainders[ia] > remainders[ib]
		}
		return ia < ib
	})
	for k := 0; k < len(order) && leftover > 0; k++ {
		shares[order[k]]++
		leftover--
	}
	return shares
}

// ChildShares distributes netPayout across children by their weights.
// Shares always sum back to netPayout exactly — per-child independent
// rounding would lose or fabricate fils, so the largest-remainder
// allocation is used (see AllocateRemainder).
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	weights := make([]int64, len(children))
	for i, c := range children {
		weights[i] = c.WeightBps
	}
	return AllocateRemainder(netPayout, weights)
}
