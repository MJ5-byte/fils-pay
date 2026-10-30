package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// The scheme file amount must be the truncated figure (ADR-0002), never a
// rounded one: the memo's "statement always a few fils higher" came from
// rounding here.
func TestSchemeAmountTextTruncatesNeverRounds(t *testing.T) {
	cases := map[int64]string{
		4745:  "4.74", // was stored as 4.75
		8075:  "8.07", // was 8.08
		999:   "0.99", // was 1.00
		9999:  "9.99", // was 10.00
		93279: "93.27",
		4740:  "4.74",
		0:     "0.00",
	}
	for gross, want := range cases {
		if got := SchemeAmountText(money.Fils(gross)); got != want {
			t.Errorf("SchemeAmountText(%d) = %q, want %q", gross, got, want)
		}
	}
}
