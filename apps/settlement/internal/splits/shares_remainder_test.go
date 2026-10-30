package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Finance memo: Delta Marketplace's child payouts didn't add up to the
// parent's total, a few fils short every batch. Amounts that don't divide
// evenly must still be paid out in full.
func TestChildShares_RemainderIsAllocated(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
		want       []money.Fils
	}{
		{"thirds", 10001, []int64{3333, 3333, 3334}, []money.Fils{3333, 3333, 3335}},
		{"uneven", 22677281, []int64{5000, 3000, 2000}, []money.Fils{11338641, 6803184, 4535456}},
		{"tiny", 7, []int64{4000, 3000, 3000}, []money.Fils{3, 2, 2}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			got := ChildShares(tc.netPayout, children)
			var total money.Fils
			for i, s := range got {
				total += s
				if s != tc.want[i] {
					t.Errorf("share[%d] = %d, want %d", i, s, tc.want[i])
				}
			}
			if total != tc.netPayout {
				t.Errorf("shares sum to %d, want the full net payout %d", total, tc.netPayout)
			}
		})
	}
}
