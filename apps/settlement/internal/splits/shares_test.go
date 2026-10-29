package splits

import (
	"reflect"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

func TestChildShares_SumToNet(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
		want       []money.Fils
	}{
		{"two equal", 10000, []int64{5000, 5000}, []money.Fils{5000, 5000}},
		{"three round", 9000, []int64{3000, 3000, 4000}, []money.Fils{2700, 2700, 3600}},
		{"single child", 5000, []int64{10000}, []money.Fils{5000}},
		// Rounding each share alone pays 502+301+201 = 1004 of 1003.
		{"seed 50/30/20 of 1003", 1003, []int64{5000, 3000, 2000}, []money.Fils{501, 301, 201}},
		// Rounding each share alone pays 500+300+200 = 1000 of 1001.
		{"seed 50/30/20 of 1001", 1001, []int64{5000, 3000, 2000}, []money.Fils{501, 300, 200}},
		// Largest remainder gets the leftover fil first; a tie goes to the lower index.
		{"thirds of 100", 100, []int64{3333, 3333, 3334}, []money.Fils{33, 33, 34}},
		{"thirds of 2", 2, []int64{3333, 3333, 3334}, []money.Fils{1, 0, 1}},
		{"zero net", 0, []int64{5000, 3000, 2000}, []money.Fils{0, 0, 0}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares, err := ChildShares(tc.netPayout, children)
			if err != nil {
				t.Fatalf("ChildShares: %v", err)
			}
			if !reflect.DeepEqual(shares, tc.want) {
				t.Errorf("shares = %v, want %v", shares, tc.want)
			}
			var total money.Fils
			for _, s := range shares {
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d", total, tc.netPayout)
			}
		})
	}
}

func TestChildShares_NegativeNetPaysNothing(t *testing.T) {
	children := []ChildWeight{{WeightBps: 5000}, {WeightBps: 3000}, {WeightBps: 2000}}
	shares, err := ChildShares(-1003, children)
	if err != nil {
		t.Fatalf("ChildShares: %v", err)
	}
	if want := []money.Fils{0, 0, 0}; !reflect.DeepEqual(shares, want) {
		t.Errorf("shares = %v, want %v", shares, want)
	}
}

func TestChildShares_RejectsWeightsNotSummingToWhole(t *testing.T) {
	cases := []struct {
		name       string
		weightsBps []int64
	}{
		{"no children", nil},
		{"under 100%", []int64{5000, 3000}},
		{"over 100%", []int64{5000, 3000, 3000}},
		{"zero weight", []int64{10000, 0}},
		{"negative weight", []int64{11000, -1000}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			if _, err := ChildShares(1003, children); err == nil {
				t.Error("ChildShares accepted weights that do not sum to 10000 bps")
			}
		})
	}
}
