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
	ctx := context.Background()

	// CloseBatch adds this batch's 100,000,000 BD gross to the platform-wide
	// volume counter, which puts it far past the volume-tier threshold. Put
	// the counter back afterwards, or every later batch on this database is
	// charged the tier bonus and the fee assertions in batch_test.go fail.
	var originalProcessed int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&originalProcessed); err != nil {
		t.Fatalf("read platform_stats: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, originalProcessed); err != nil {
			t.Errorf("restore platform_stats: %v", err)
		}
	})

	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// 100,000,000.00 BD in fils: /1000 = 100000000.00, nine integer
	// digits, one past NUMERIC(10,2)'s eight-digit ceiling.
	const largeGrossFils money.Fils = 100_000_000_000
	insertCaptureEvent(t, pool, merchantID, mdrBps, largeGrossFils, start.Add(time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch on a large capture: %v", err)
	}

	lines, err := LoadSchemeExportLines(ctx, pool, result.BatchID)
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
