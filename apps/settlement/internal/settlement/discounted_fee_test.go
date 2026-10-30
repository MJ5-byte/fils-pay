package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Parity table for ComputeSettlementFee. Every `want` is what the TS ledger
// posts for the same inputs (estimateFeeFils in apps/api/src/fees/estimate.ts:
// the MDR fee on the amount, then the discount rebated off that fee), so
// settlement charges exactly what capture journaled. The two tie rows are
// where discounting the amount first would land one fil lower.
func TestComputeSettlementFee(t *testing.T) {
	cases := []struct {
		name        string
		amount      money.Fils
		mdrBps      int64
		discountBps int64
		want        money.Fils
	}{
		{
			name:        "602 fils at 275bps MDR with a 1250bps discount",
			amount:      602,
			mdrBps:      275,
			discountBps: 1250,
			// fee: 602*275/10000 = 16.555 -> 17; rebate: 17*1250/10000 = 2.125 -> 2; 17-2 = 15
			want: 15,
		},
		{
			name:        "rebate on an exact tie rounds to even 0",
			amount:      200,
			mdrBps:      250,
			discountBps: 1000,
			// fee: 200*250/10000 = 5 exactly; rebate: 5*1000/10000 = 0.5 ties to 0; 5-0 = 5
			want: 5,
		},
		{
			name:        "rebate on an exact tie rounds to even 2",
			amount:      600,
			mdrBps:      250,
			discountBps: 1000,
			// fee: 600*250/10000 = 15 exactly; rebate: 15*1000/10000 = 1.5 ties to 2; 15-2 = 13
			want: 13,
		},
		{
			name:        "100000 fils at 275bps MDR with a 1250bps discount",
			amount:      100_000,
			mdrBps:      275,
			discountBps: 1250,
			// fee: 2750 exactly; rebate: 2750*1250/10000 = 343.75 -> 344; 2750-344 = 2406
			want: 2406,
		},
		{
			name:        "4750 fils at 250bps MDR with a 2000bps discount",
			amount:      4750,
			mdrBps:      250,
			discountBps: 2000,
			// fee: 118.75 -> 119; rebate: 119*2000/10000 = 23.8 -> 24; 119-24 = 95
			want: 95,
		},
		{
			name:        "a full 10000bps discount rebates the whole fee",
			amount:      50_000,
			mdrBps:      320,
			discountBps: 10_000,
			want:        0,
		},
		{
			name:        "zero amount, zero fee",
			amount:      0,
			mdrBps:      275,
			discountBps: 1250,
			want:        0,
		},
		{
			name:        "a 9 billion BD capture at a 100% rate does not overflow int64",
			amount:      9_000_000_000_000,
			mdrBps:      10_000,
			discountBps: 3333,
			// fee: 9e12; rebate: 9e12*3333/10000 = 2.9997e12; 9e12-2.9997e12 = 6.0003e12
			want: 6_000_300_000_000,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ComputeSettlementFee(tc.amount, tc.mdrBps, tc.discountBps)
			if got != tc.want {
				t.Fatalf("ComputeSettlementFee(%d, %d, %d) = %d, want %d",
					tc.amount, tc.mdrBps, tc.discountBps, got, tc.want)
			}
		})
	}
}

// Every merchant without a negotiated discount (the 0047 column default)
// must settle exactly as it did before the column existed.
// With a zero discount both orderings (discount first, fee first) agree, so
// this test cannot tell them apart.
func TestComputeSettlementFeeZeroDiscountMatchesApplyRateFils(t *testing.T) {
	rates := []int64{0, 180, 250, 275, 320, 10_000}
	for _, amount := range []money.Fils{0, 1, 3, 602, 4750, 9973, 123_457, 5_000_000} {
		for _, mdrBps := range rates {
			got := ComputeSettlementFee(amount, mdrBps, 0)
			want := money.ApplyRateFils(amount, mdrBps)
			if got != want {
				t.Fatalf("ComputeSettlementFee(%d, %d, 0) = %d, want ApplyRateFils = %d",
					amount, mdrBps, got, want)
			}
		}
	}
}
