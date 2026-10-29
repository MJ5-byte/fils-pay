package splits

import (
	"reflect"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// TestChildShares_SumToNet pins the largest-remainder contract: across
// cases that divide exactly AND adversarial ones where per-child
// independent rounding would lose or fabricate fils (the exact-divide
// cases alone were vacuous — they can never fail), sum(shares) must equal
// netPayout exactly, and the largest-remainder method must distribute the
// leftover fils by descending remainder, ties broken by ascending index.
func TestChildShares_SumToNet(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
		want       []money.Fils // nil = only assert the sum
	}{
		{"two equal", 10000, []int64{5000, 5000}, nil},
		{"three round", 9000, []int64{3000, 3000, 4000}, nil},
		{"single child", 5000, []int64{10000}, nil},
		// 101 fils @ 3333/3333/3334: per-child ApplyRateFils gives
		// 33/33/33 (sum 99, shortfall). Largest-remainder gives 34/33/34.
		{"adversarial 3333/3333/3334", 101, []int64{3333, 3333, 3334}, []money.Fils{34, 33, 34}},
		// 101 fils @ 5000/5000: independent bankers rounding gives
		// 50/50 (sum 100). Largest-remainder gives 51/50.
		{"adversarial 5000/5000", 101, []int64{5000, 5000}, []money.Fils{51, 50}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for _, s := range shares {
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d (shares %v)", total, tc.netPayout, shares)
			}
			if tc.want != nil && !reflect.DeepEqual(shares, tc.want) {
				t.Errorf("shares = %v, want %v", shares, tc.want)
			}
		})
	}
}
