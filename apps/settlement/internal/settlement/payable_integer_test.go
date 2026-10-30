package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// The float32 version returned 19440119 here, a fils short (finance memo:
// payouts and the lifetime estimate drift for high-volume merchants).
func TestNetPayableFilsIsExactForLargeBatches(t *testing.T) {
	cases := [][3]int64{
		{20000123, 560003, 19440120},
		{1195767544, 33481491, 1162286053},
		{4750, 119, 4631},
	}
	for _, c := range cases {
		if got := NetPayableFils(money.Fils(c[0]), money.Fils(c[1])); int64(got) != c[2] {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}
