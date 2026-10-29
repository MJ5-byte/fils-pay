package splits

import (
	"fmt"
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights with
// the largest-remainder method, the same rule as packages/money's
// allocateRemainder: each child gets the floor of its exact share, then the
// leftover fils go one each to the largest remainders, ties to the lower
// index. A positive netPayout's shares always sum to it exactly. Rounding
// each share on its own cannot promise that, and every fil it over- or
// under-pays leaves the parent's ledger out of step with its batch.
//
// The weights must be positive and sum to 10000 bps (0045's contract);
// anything else is rejected rather than paid out wrong.
func ChildShares(netPayout money.Fils, children []ChildWeight) ([]money.Fils, error) {
	var totalBps int64
	for _, c := range children {
		if c.WeightBps <= 0 {
			return nil, fmt.Errorf("splits: child weight %d bps is not positive", c.WeightBps)
		}
		totalBps += c.WeightBps
	}
	if totalBps != 10_000 {
		return nil, fmt.Errorf("splits: child weights sum to %d bps, want 10000", totalBps)
	}

	out := make([]money.Fils, len(children))
	if netPayout <= 0 {
		// Nothing to pay out: every child gets zero, as PayoutSplitBatch
		// already skipped non-positive shares before this rule existed.
		return out, nil
	}
	remainders := make([]int64, len(children))
	leftover := netPayout
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / 10_000)
		remainders[i] = product % 10_000
		leftover -= out[i]
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	// leftover < len(children): each floor drops less than one fil.
	for _, i := range order[:leftover] {
		out[i]++
	}
	return out, nil
}
