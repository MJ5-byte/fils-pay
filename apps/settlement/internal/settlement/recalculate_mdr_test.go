package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// recalcWindow returns the half-open [from, to) range covering exactly the
// one business date a test closed its batch on.
func recalcWindow(businessDate time.Time) (time.Time, time.Time) {
	return businessDate, businessDate.AddDate(0, 0, 1)
}

// MK: this is the finance flow. history gets rewritten at the new rate, that's intended.
func TestRecalculateMDR_RecomputesAtCurrentRate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	businessDate := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	// Three separate events, so the recomputation has to sum per-event fees
	// rather than rate a pre-summed total — the amounts are chosen so the
	// two differ.
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 4750, start.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 1333, start.Add(2*time.Hour))
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 999, start.Add(3*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	// Finance negotiates the rate up by 50bps and asks for the historical
	// batch to reflect it.
	const newMdrBps = 300
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = $2 WHERE id = $1`, merchantID, newMdrBps); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	if result.BatchesConsidered != 1 {
		t.Fatalf("BatchesConsidered = %d, want 1", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1", len(result.Adjusted))
	}

	// The expected fee is ComputeSettlementFee per event at the NEW rate,
	// summed — the same per-event-then-sum discipline CloseBatch step 8
	// uses.
	wantFee := ComputeSettlementFee(4750, newMdrBps, 0) +
		ComputeSettlementFee(1333, newMdrBps, 0) +
		ComputeSettlementFee(999, newMdrBps, 0)

	adj := result.Adjusted[0]
	if adj.BatchID != closed.BatchID {
		t.Errorf("adjusted BatchID = %s, want %s", adj.BatchID, closed.BatchID)
	}
	if adj.OldFeeFils != closed.FeeFils {
		t.Errorf("OldFeeFils = %d, want %d", adj.OldFeeFils, closed.FeeFils)
	}
	if adj.NewFeeFils != wantFee {
		t.Errorf("NewFeeFils = %d, want %d", adj.NewFeeFils, wantFee)
	}
	if adj.DiffFils != wantFee-closed.FeeFils {
		t.Errorf("DiffFils = %d, want %d", adj.DiffFils, wantFee-closed.FeeFils)
	}

	// net_payout_fils must move in lockstep with the new fee.
	var gotFee, gotNet int64
	err = pool.QueryRow(ctx, `
		SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1
	`, closed.BatchID).Scan(&gotFee, &gotNet)
	if err != nil {
		t.Fatalf("read recalculated batch: %v", err)
	}
	if gotFee != int64(wantFee) {
		t.Errorf("persisted fee_fils = %d, want %d", gotFee, wantFee)
	}
	if gotNet != int64(closed.GrossFils)-int64(wantFee) {
		t.Errorf("persisted net_payout_fils = %d, want %d", gotNet, int64(closed.GrossFils)-int64(wantFee))
	}
}

// YA: the 0007 trigger also rejects UPDATE/DELETE on ledger_entries, so these groups can't be edited afterwards
func TestRecalculateMDR_AdjustmentLedgerGroupBalances(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 200
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	businessDate := time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 20_000, start.Add(time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, businessDate); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 275 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	// Every adjustment group this pass posted must sum debits - credits = 0.
	rows, err := pool.Query(ctx, `
		SELECT entry_group_id,
		       SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) AS net
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
		 GROUP BY entry_group_id
	`, merchantID)
	if err != nil {
		t.Fatalf("query adjustment groups: %v", err)
	}
	defer rows.Close()

	groups := 0
	for rows.Next() {
		var groupID uuid.UUID
		var net int64
		if err := rows.Scan(&groupID, &net); err != nil {
			t.Fatalf("scan adjustment group: %v", err)
		}
		groups++
		if net != 0 {
			t.Errorf("adjustment group %s nets %d fils, want 0", groupID, net)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate adjustment groups: %v", err)
	}
	if groups != 1 {
		t.Errorf("posted %d adjustment groups, want 1", groups)
	}
}

func TestRecalculateMDR_UnchangedRateAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 7_500, start.Add(time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, businessDate); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	// No rate change: the recomputation must land on exactly the figure the
	// batch already froze, so nothing is posted and nothing is rewritten.
	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 1 {
		t.Errorf("BatchesConsidered = %d, want 1", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("len(Adjusted) = %d, want 0 (an unchanged rate is a no-op)", len(result.Adjusted))
	}

	var adjustmentCount int64
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM ledger_entries
		 WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
	`, merchantID).Scan(&adjustmentCount)
	if err != nil {
		t.Fatalf("count adjustments: %v", err)
	}
	if adjustmentCount != 0 {
		t.Errorf("posted %d adjustment legs, want 0", adjustmentCount)
	}
}

func TestRecalculateMDR_OutOfRangeBatchUntouched(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	inRangeDate := time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC)
	outOfRangeDate := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC)

	inStart, _ := BusinessDayWindow(inRangeDate)
	outStart, _ := BusinessDayWindow(outOfRangeDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 6_000, inStart.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 6_000, outStart.Add(time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, inRangeDate); err != nil {
		t.Fatalf("CloseBatch(in range): %v", err)
	}
	outBatch, err := CloseBatch(ctx, pool, merchantID, outOfRangeDate)
	if err != nil {
		t.Fatalf("CloseBatch(out of range): %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 400 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(inRangeDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 1 {
		t.Errorf("BatchesConsidered = %d, want 1 (the out-of-range batch must not be selected)", result.BatchesConsidered)
	}

	var gotFee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, outBatch.BatchID).Scan(&gotFee); err != nil {
		t.Fatalf("read out-of-range batch: %v", err)
	}
	if gotFee != int64(outBatch.FeeFils) {
		t.Errorf("out-of-range batch fee_fils = %d, want %d (unchanged)", gotFee, outBatch.FeeFils)
	}
}

// A paid batch's net payout has already left the platform, so a rate change
// must not rewrite it or post an adjustment against it; only the closed,
// still-unpaid batch in the same range is recalculated.
func TestRecalculateMDR_PaidBatchUntouched(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 275
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	paidDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	closedDate := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	paidStart, _ := BusinessDayWindow(paidDate)
	closedStart, _ := BusinessDayWindow(closedDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 24_000, paidStart.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 24_000, closedStart.Add(time.Hour))

	paid, err := CloseBatch(ctx, pool, merchantID, paidDate)
	if err != nil {
		t.Fatalf("CloseBatch(paid): %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, paid.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	closed, err := CloseBatch(ctx, pool, merchantID, closedDate)
	if err != nil {
		t.Fatalf("CloseBatch(closed): %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	result, err := RecalculateMDR(ctx, pool, merchantID, paidDate, closedDate.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 1 {
		t.Errorf("BatchesConsidered = %d, want 1 (the paid batch must not be selected)", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 1 || result.Adjusted[0].BatchID != closed.BatchID {
		t.Errorf("Adjusted = %+v, want only the closed batch %s", result.Adjusted, closed.BatchID)
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `
		SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1
	`, paid.BatchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read paid batch: %v", err)
	}
	if gotFee != int64(paid.FeeFils) || gotNet != int64(paid.NetPayoutFils) {
		t.Errorf("paid batch fee/net = %d/%d, want %d/%d (unchanged)", gotFee, gotNet, paid.FeeFils, paid.NetPayoutFils)
	}

	var paidAdjustments int64
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND description = 'MDR recalculation adjustment'
	`, paid.BatchID).Scan(&paidAdjustments); err != nil {
		t.Fatalf("count paid batch adjustments: %v", err)
	}
	if paidAdjustments != 0 {
		t.Errorf("posted %d adjustment legs against the paid batch, want 0", paidAdjustments)
	}
}

// compile-time assertion that RecalculateMDR keeps the *pgxpool.Pool
// signature the internal API handler passes it.
var _ func(context.Context, *pgxpool.Pool, uuid.UUID, time.Time, time.Time) (RecalcResult, error) = RecalculateMDR

// A batch that carries a refund has its fee stored net of the reversed
// fee, so recomputing at the same rate must subtract that reversal too,
// or it posts a phantom fee increase equal to the reversed fee.
func TestRecalculateMDR_RefundInBatchUnchangedRateAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 7, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 4000, 100, start.Add(2*time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, businessDate); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("unchanged rate adjusted %d batch(es): %+v", len(result.Adjusted), result.Adjusted)
	}
}

// A fully refunded sale closes at gross 0, fee 0, net 0. Raising the rate then
// recomputes fee = 300 charged at the new rate - 250 reversed = 50, so net
// would be -50. A negative batch has no payout leg to recover the money (and
// settlement_batches_net_payout_non_negative refuses it), so that batch keeps
// its figures and is reported as skipped while the rest of the range applies.
func TestRecalculateMDR_SkipsBatchWhoseNetWouldGoNegative(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	refundedDay := time.Date(2026, 4, 6, 0, 0, 0, 0, time.UTC)
	refundedStart, _ := BusinessDayWindow(refundedDay)
	txnID, fee := insertCaptureEvent(t, pool, merchantID, originalMdrBps, 10000, refundedStart.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 10000, fee, refundedStart.Add(2*time.Hour))
	refunded, err := CloseBatch(ctx, pool, merchantID, refundedDay)
	if err != nil {
		t.Fatalf("CloseBatch (refunded day): %v", err)
	}
	if refunded.GrossFils != 0 || refunded.FeeFils != 0 || refunded.NetPayoutFils != 0 {
		t.Fatalf("refunded batch = gross %d, fee %d, net %d; want 0, 0, 0", refunded.GrossFils, refunded.FeeFils, refunded.NetPayoutFils)
	}

	normalDay := refundedDay.AddDate(0, 0, 1)
	normalStart, _ := BusinessDayWindow(normalDay)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 4000, normalStart.Add(time.Hour))
	normal, err := CloseBatch(ctx, pool, merchantID, normalDay)
	if err != nil {
		t.Fatalf("CloseBatch (normal day): %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	result, err := RecalculateMDR(ctx, pool, merchantID, refundedDay, normalDay.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 2 {
		t.Errorf("BatchesConsidered = %d, want 2", result.BatchesConsidered)
	}
	if len(result.Skipped) != 1 || result.Skipped[0] != refunded.BatchID {
		t.Errorf("Skipped = %v, want [%s]", result.Skipped, refunded.BatchID)
	}
	if len(result.Adjusted) != 1 || result.Adjusted[0].BatchID != normal.BatchID {
		t.Fatalf("Adjusted = %+v, want only the normal day's batch %s", result.Adjusted, normal.BatchID)
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, refunded.BatchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read skipped batch: %v", err)
	}
	if gotFee != 0 || gotNet != 0 {
		t.Errorf("skipped batch = fee %d, net %d; want unchanged 0, 0", gotFee, gotNet)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'MDR recalculation adjustment'`, refunded.BatchID); n != 0 {
		t.Errorf("skipped batch got %d adjustment ledger legs, want 0", n)
	}
}
