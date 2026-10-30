package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
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

// BHA-183: a capture whose negotiated-discount rebate posted short was
// charged at close only the rebate actually posted, so recomputing at the
// same rate must not price the full discount back in. 10 000 at 250 bps is a
// 250 fee; a 9 500 refund lands before the 1000 bps discount, so the rebate
// is 1, not 25 (BHA-169), and the last 500 refund reverses the 11 still held.
// The batch fee is 250 - 1 - 238 - 11 = 0; full-discount pricing made it -24.
func TestRecalculateMDR_ShortRebateUnchangedRateAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("set negotiated_discount_bps: %v", err)
	}

	businessDate := time.Date(2026, 4, 8, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id
	`, merchantID, "acq-ref-"+uuid.New().String(), start.Add(time.Hour)).Scan(&txnID); err != nil {
		t.Fatalf("insert transaction: %v", err)
	}
	insertJournaledCapture(t, pool, merchantID, txnID, "captured", 10000, 250, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 9500, 238, start.Add(2*time.Hour))
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'platform_fee_revenue', 'debit',  1, $4, 'capture: negotiated discount adjustment'),
		  ($1, $2, $3, 'merchant_payable',     'credit', 1, $4, 'capture: negotiated discount adjustment')
	`, uuid.New(), merchantID, txnID, start.Add(3*time.Hour)); err != nil {
		t.Fatalf("insert discount adjustment: %v", err)
	}
	insertRefund(t, pool, merchantID, txnID, "succeeded", 500, 11, start.Add(4*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 0 {
		t.Fatalf("CloseBatch FeeFils = %d, want 0", closed.FeeFils)
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

// BHA-194: raising MDR must discount the fee increase, charging 37 fils instead of 38.
func TestRecalculateMDR_RateIncreaseRebatesDiscountOnIncrease(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("set negotiated_discount_bps: %v", err)
	}

	businessDate := time.Date(2026, 4, 12, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	for i, capture := range []struct {
		amountFils money.Fils
		feeFils    money.Fils
		rebateFils int64
	}{
		{600, 15, 2},
		{200, 5, 0},
		{602, 15, 2},
	} {
		occurredAt := start.Add(time.Duration(i+1) * time.Hour)
		var txnID uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
			VALUES ($1, 'captured', $2, $2, $3, $4) RETURNING id
		`, merchantID, int64(capture.amountFils), "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID); err != nil {
			t.Fatalf("insert transaction: %v", err)
		}
		insertJournaledCapture(t, pool, merchantID, txnID, "captured", capture.amountFils, capture.feeFils, occurredAt)
		if capture.rebateFils > 0 {
			if _, err := pool.Exec(ctx, `
				INSERT INTO ledger_entries
				  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
				VALUES
				  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'capture: negotiated discount adjustment'),
				  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: negotiated discount adjustment')
			`, uuid.New(), merchantID, txnID, capture.rebateFils, occurredAt.Add(time.Minute)); err != nil {
				t.Fatalf("insert discount adjustment: %v", err)
			}
		}
	}

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 31 {
		t.Fatalf("CloseBatch FeeFils = %d, want 31", closed.FeeFils)
	}

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
		t.Errorf("BatchesConsidered = %d, want 1", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1", len(result.Adjusted))
	}
	adj := result.Adjusted[0]
	if adj.BatchID != closed.BatchID {
		t.Errorf("adjusted BatchID = %s, want %s", adj.BatchID, closed.BatchID)
	}
	if adj.OldFeeFils != 31 {
		t.Errorf("OldFeeFils = %d, want 31", adj.OldFeeFils)
	}
	if adj.NewFeeFils != 37 {
		t.Errorf("NewFeeFils = %d, want 37", adj.NewFeeFils)
	}
	if adj.DiffFils != 6 {
		t.Errorf("DiffFils = %d, want 6", adj.DiffFils)
	}
}

// BHA-199: an unchanged fee schedule must not adjust a batch priced at its scheduled rate.
func TestRecalculateMDR_FeeScheduleUnchangedRateAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	businessDate := time.Date(2026, 4, 13, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertFeeSchedule(t, pool, merchantID, 200, start.AddDate(0, 0, -1))
	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id
	`, merchantID, "acq-ref-"+uuid.New().String(), start.Add(time.Hour)).Scan(&txnID); err != nil {
		t.Fatalf("insert transaction: %v", err)
	}
	insertJournaledCapture(t, pool, merchantID, txnID, "captured", 10000, 200, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 200 {
		t.Fatalf("CloseBatch FeeFils = %d, want 200", closed.FeeFils)
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

// A sale captured in parts on two business days has a fee leg and a rebate in
// each day's batch. Recalculating either batch at the same rate must read only
// that day's fee legs, the same window as its rebates, and adjust nothing.
func TestRecalculateMDR_SplitCaptureAcrossDaysUnchangedRateAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("set negotiated_discount_bps: %v", err)
	}

	day1 := time.Date(2026, 4, 14, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)
	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', 1202, 1202, $2, $3) RETURNING id
	`, merchantID, "acq-ref-"+uuid.New().String(), start1.Add(time.Hour)).Scan(&txnID); err != nil {
		t.Fatalf("insert transaction: %v", err)
	}
	for _, part := range []struct {
		at         time.Time
		amountFils money.Fils
	}{
		{start1.Add(time.Hour), 600},
		{start2.Add(time.Hour), 602},
	} {
		insertJournaledCapture(t, pool, merchantID, txnID, "captured", part.amountFils, 15, part.at)
		if _, err := pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'platform_fee_revenue', 'debit',  2, $4, 'capture: negotiated discount adjustment'),
			  ($1, $2, $3, 'merchant_payable',     'credit', 2, $4, 'capture: negotiated discount adjustment')
		`, uuid.New(), merchantID, txnID, part.at.Add(time.Minute)); err != nil {
			t.Fatalf("insert discount adjustment: %v", err)
		}
	}

	for _, day := range []time.Time{day1, day2} {
		closed, err := CloseBatch(ctx, pool, merchantID, day)
		if err != nil {
			t.Fatalf("CloseBatch %s: %v", day.Format("2006-01-02"), err)
		}
		if closed.FeeFils != 13 {
			t.Fatalf("CloseBatch %s FeeFils = %d, want 13", day.Format("2006-01-02"), closed.FeeFils)
		}
	}

	from, _ := recalcWindow(day1)
	_, to := recalcWindow(day2)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("unchanged rate adjusted %d batch(es): %+v", len(result.Adjusted), result.Adjusted)
	}
}
