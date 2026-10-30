package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Net payout must equal gross minus fee to the fil (ADR-0001), including
// batches above float32's exact-integer range of 16,777,216 fils.
func TestNetPayableFilsIsExactGrossMinusFee(t *testing.T) {
	cases := []struct {
		gross, fee, want money.Fils
	}{
		{24_000, 578, 23_422},
		{16_777_217, 0, 16_777_217},
		{20_000_123, 578, 19_999_545},
		{123_456_789, 3_086_420, 120_370_369},
	}
	for _, c := range cases {
		if got := NetPayableFils(c.gross, c.fee); got != c.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c.gross, c.fee, got, c.want)
		}
	}
}
