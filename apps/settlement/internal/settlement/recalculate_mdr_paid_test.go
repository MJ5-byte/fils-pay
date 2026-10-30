package settlement

import (
	"context"
	"testing"
	"time"
)

// Finance memo: "MDR recalculation changed batches that were already paid
// out. Those should never change." The adjustment is still posted, but the
// paid batch row keeps the figures that went to the bank.
func TestRecalculateMDR_PaidBatchFiguresUnchanged(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	businessDate := time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 4750, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, closed.BatchID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1 (the correction is still posted)", len(result.Adjusted))
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).
		Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != int64(closed.FeeFils) || gotNet != int64(closed.NetPayoutFils) {
		t.Errorf("paid batch changed: fee %d→%d, net %d→%d; want unchanged",
			closed.FeeFils, gotFee, closed.NetPayoutFils, gotNet)
	}
}
