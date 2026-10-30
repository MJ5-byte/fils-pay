package settlement

import (
	"context"
	"testing"
	"time"
)

// FP-212 / FP-300: a refund reduces the payout of the business day it
// happened on. net = gross - fee - refunded + fee reversed.
func TestCloseBatch_RefundsReducePayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10000, start.Add(time.Hour))

	// A refund of 4000 that reversed 100 fils of fee, recorded the way
	// processRefund records it: negative amount, feeReversedFils in metadata.
	if _, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
		VALUES ($1, 'refund_partial', -4000, 'system', '{"feeReversedFils": 100}', $2)
	`, txnID, start.Add(2*time.Hour)); err != nil {
		t.Fatalf("insert refund event: %v", err)
	}

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var gross, fee, refunded, feeReversed, net int64
	if err := pool.QueryRow(ctx, `
		SELECT gross_fils, fee_fils, refunded_fils, fee_reversed_fils, net_payout_fils
		  FROM settlement_batches WHERE id = $1
	`, result.BatchID).Scan(&gross, &fee, &refunded, &feeReversed, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gross != 10000 || refunded != 4000 || feeReversed != 100 {
		t.Errorf("gross/refunded/feeReversed = %d/%d/%d, want 10000/4000/100", gross, refunded, feeReversed)
	}
	if want := gross - fee - refunded + feeReversed; net != want {
		t.Errorf("net_payout_fils = %d, want %d (gross %d - fee %d - refunded %d + fee reversed %d)",
			net, want, gross, fee, refunded, feeReversed)
	}

	// The refund event is batched, so a re-run can't count it twice.
	var unbatched int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM transaction_events WHERE transaction_id = $1 AND settlement_batch_id IS NULL
	`, txnID).Scan(&unbatched); err != nil {
		t.Fatalf("count unbatched: %v", err)
	}
	if unbatched != 0 {
		t.Errorf("%d event(s) left unbatched, want 0", unbatched)
	}
}
