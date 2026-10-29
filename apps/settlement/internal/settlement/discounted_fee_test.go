package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Hand-derived table for ComputeSettlementFee. Every `want` below is
// worked out fee-first: the MDR is BankersRoundDiv-ed against the full
// amount, then the discount rate is applied to the fee itself — the order
// the API fee preview shows and the one that keeps a discount from
// rounding an entire small fee away.
// (was discount-first; am flagged api 15 vs go 14 on 602@275/1250 — that
// divergence is the F2b bug this table now pins: go now returns 15 too.)
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
			// fee: 602*275/10000 = 165550/10000 -> quotient 16, remainder 5550, 2*5550=11100 > 10000 -> 17
			// discount on fee: 17*1250/10000 = 21250/10000 -> quotient 2, remainder 1250, 2*1250=2500 < 10000 -> 2
			// fee = 17 - 2 = 15
			want: 15,
		},
		{
			name:        "100000 fils at 275bps MDR with a 1250bps discount",
			amount:      100_000,
			mdrBps:      275,
			discountBps: 1250,
			// fee: 100000*275/10000 = 2750 exactly
			// discount on fee: 2750*1250/10000 = 3437500/10000 -> quotient 343,
			// remainder 7500, 2*7500=15000 > 10000 -> 344
			// fee = 2750 - 344 = 2406
			want: 2406,
		},
		{
			name:        "4750 fils at 250bps MDR with a 2000bps discount",
			amount:      4750,
			mdrBps:      250,
			discountBps: 2000,
			// fee: 4750*250/10000 = 1187500/10000 -> quotient 118, remainder 7500, 2*7500=15000 > 10000 -> 119
			// discount on fee: 119*2000/10000 = 238000/10000 -> quotient 23, remainder 8000, 2*8000=16000 > 10000 -> 24
			// fee = 119 - 24 = 95
			want: 95,
		},
		{
			name:        "a full 10000bps discount leaves nothing to charge MDR against",
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
			name:        "divergence: 23 fils at 225bps MDR with a 500bps discount",
			amount:      23,
			mdrBps:      225,
			discountBps: 500,
			// fee-first: fee = round(23*225/10000) = round(0.5175) = 1;
			// discount on fee = round(1*500/10000) = 0 -> fee 1
			// discount-first (the old formula): discount = round(23*500/10000) = 1,
			// amount -> 22, fee = round(22*225/10000) = 0
			want: 1,
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
