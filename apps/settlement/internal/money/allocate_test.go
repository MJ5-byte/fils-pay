package money

import "testing"

// Per-child ApplyRateFils rounded each share separately, so three equal
// children of 10001 fils got 3334+3334+3334 = 10002 (or lost fils for other
// totals). AllocateByWeights always sums to the total.
func TestAllocateByWeights_SumsToTotal(t *testing.T) {
	cases := []struct {
		total   Fils
		weights []int64
	}{
		{10001, []int64{3333, 3333, 3334}},
		{99999, []int64{3333, 3333, 3334}},
		{7, []int64{5000, 5000}},
		{123457, []int64{2500, 2500, 2500, 2500}},
		{5000, []int64{10000}},
		{1000, []int64{1, 1, 1}},
	}
	for _, tc := range cases {
		shares := AllocateByWeights(tc.total, tc.weights)
		var sum Fils
		for _, s := range shares {
			if s < 0 {
				t.Fatalf("AllocateByWeights(%d, %v) produced a negative share: %v", tc.total, tc.weights, shares)
			}
			sum += s
		}
		if sum != tc.total {
			t.Errorf("AllocateByWeights(%d, %v) = %v, sums to %d", tc.total, tc.weights, shares, sum)
		}
	}
}
