package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// TestSchemeExportLargeCaptureDoesNotOverflow closes a batch holding one
// capture whose BD value needs more than the eight integer digits a
// NUMERIC(10,2) column can hold (100,000,000.00 BD). Batch close must still
// succeed and the exported line must carry the full amount, formatted from
// the BIGINT amount_fils rather than a narrow decimal copy that overflows.
func TestSchemeExportLargeCaptureDoesNotOverflow(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// 100,000,000.00 BD in fils: /1000 = 100000000.00, nine integer
	// digits, one past NUMERIC(10,2)'s eight-digit ceiling.
	const largeGrossFils money.Fils = 100_000_000_000
	insertCaptureEvent(t, pool, merchantID, mdrBps, largeGrossFils, start.Add(time.Hour))

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch on a large capture: %v", err)
	}

	lines, err := LoadSchemeExportLines(context.Background(), pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("expected 1 exported line, got %d", len(lines))
	}
	if got, want := lines[0].Amount, "100000000.00"; got != want {
		t.Errorf("exported amount = %q, want %q", got, want)
	}
}
