package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils went through float32 BD, which has a 24-bit mantissa and
// loses whole fils on any batch above ~16,777 BD.
func TestNetPayableFils_LargeBatchIsExact(t *testing.T) {
	gross, fee := money.Fils(123_456_789), money.Fils(3_086_420)
	if got, want := NetPayableFils(gross, fee), money.Fils(120_370_369); got != want {
		t.Fatalf("NetPayableFils(%d, %d) = %d, want %d", gross, fee, got, want)
	}
}
