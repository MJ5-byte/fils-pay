package settlement

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// mustPool connects to DATABASE_URL (matching how the TS tests connect —
// same env var, same "run `npm run migrate` first" contract) or skips the
// test if it isn't set, so `go test ./...` still runs cleanly without a
// live Postgres.
// am: these all skip when DATABASE_URL isn't set, so 'ok' means nothing. (fixed? CI has pg now, FP-270)
func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (run against a real, migrated Postgres)")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("failed to connect to DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func insertActiveMerchant(t *testing.T, pool *pgxpool.Pool, mdrBps int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, $2, 'active', false)
		RETURNING id
	`, "settlement-batch-test-"+uuid.New().String(), mdrBps).Scan(&id)
	if err != nil {
		t.Fatalf("insertActiveMerchant: %v", err)
	}
	return id
}

// insertCaptureEvent inserts one transactions row (status 'captured',
// captured_fils = amountFils = amountFils, matching a single full capture)
// plus one matching transaction_events row and the matching ledger_entries
// pair(s) that apps/api's capture.ts would have posted for that exact
// event — the gross leg pair, plus the fee leg pair computed with the same
// ApplyRateFils formula CloseBatch itself uses, so a test can assert
// CloseBatch's independently recomputed fee lands on the same figure
// capture-time already posted.
func insertCaptureEvent(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, mdrBps int64, amountFils money.Fils, occurredAt time.Time) (txnID uuid.UUID, feeFils money.Fils) {
	t.Helper()
	ctx := context.Background()

	err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, int64(amountFils), "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert transaction: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'captured', $2, 'system', $3)
	`, txnID, int64(amountFils), occurredAt)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert transaction_events: %v", err)
	}

	feeFils = money.ApplyRateFils(amountFils, mdrBps)
	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $5, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: gross')
	`, groupID, merchantID, txnID, int64(amountFils), occurredAt)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert gross ledger legs: %v", err)
	}
	if feeFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'capture: MDR fee'),
			  ($1, $2, $3, 'platform_fee_revenue', 'credit', $4, $5, 'capture: MDR fee')
		`, groupID, merchantID, txnID, int64(feeFils), occurredAt)
		if err != nil {
			t.Fatalf("insertCaptureEvent: insert fee ledger legs: %v", err)
		}
	}

	return txnID, feeFils
}

// insertAdditionalCaptureEvent adds a SECOND transaction_events row (and
// matching ledger legs) against an EXISTING transaction — simulating a
// second partial capture on the same order later the same business day —
// without inserting a second transactions row, and without touching
// captured_fils (not needed by any assertion below).
func insertAdditionalCaptureEvent(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, mdrBps int64, amountFils money.Fils, occurredAt time.Time) money.Fils {
	t.Helper()
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'partially_captured', $2, 'system', $3)
	`, txnID, int64(amountFils), occurredAt)
	if err != nil {
		t.Fatalf("insertAdditionalCaptureEvent: insert transaction_events: %v", err)
	}

	feeFils := money.ApplyRateFils(amountFils, mdrBps)
	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $5, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: gross')
	`, groupID, merchantID, txnID, int64(amountFils), occurredAt)
	if err != nil {
		t.Fatalf("insertAdditionalCaptureEvent: insert gross ledger legs: %v", err)
	}
	if feeFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'capture: MDR fee'),
			  ($1, $2, $3, 'platform_fee_revenue', 'credit', $4, $5, 'capture: MDR fee')
		`, groupID, merchantID, txnID, int64(feeFils), occurredAt)
		if err != nil {
			t.Fatalf("insertAdditionalCaptureEvent: insert fee ledger legs: %v", err)
		}
	}
	return feeFils
}

// insertRefund inserts what apps/api's processRefund.ts writes for one
// refund: the refunds row, the negative refund transaction_events row, and
// the reversal ledger legs (gross back out of merchant_payable, the reversed
// fee back into it).
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, status string, amountFils, feeReversedFils money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var refundID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO refunds
		  (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'requested_by_customer', 'merchant_session', $7, $8)
		RETURNING id
	`, txnID, merchantID, int64(amountFils), int64(feeReversedFils), status, "acq-refund-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&refundID)
	if err != nil {
		t.Fatalf("insertRefund: insert refunds: %v", err)
	}
	if status != "succeeded" {
		return refundID
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'refund_partial', $2, 'system', $3)
	`, txnID, -int64(amountFils), occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: insert transaction_events: %v", err)
	}

	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $6, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $6, 'refund: gross'),
		  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $5, $6, 'refund: MDR fee reversal'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $5, $6, 'refund: MDR fee reversal')
	`, groupID, merchantID, txnID, int64(amountFils), int64(feeReversedFils), occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: insert ledger legs: %v", err)
	}
	return refundID
}

// countRows runs a COUNT(*) query on the shared pool, outside any test
// transaction, so it only sees committed rows.
func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("countRows(%s): %v", query, err)
	}
	return n
}

func TestCloseBatch_EligibleEventSelection(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insideWindow := start.Add(2 * time.Hour)
	beforeWindow := start.Add(-2 * time.Hour) // previous business day
	afterWindow := start.AddDate(0, 0, 1).Add(2 * time.Hour)

	// One eligible event inside the window...
	_, feeInside := insertCaptureEvent(t, pool, merchantID, mdrBps, 4750, insideWindow)
	// ...and two events that must NOT be picked up: one on the previous
	// business day, one on the next.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 9999, beforeWindow)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 8888, afterWindow)

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if result.GrossFils != 4750 {
		t.Errorf("GrossFils = %d, want 4750 (out-of-window events must be excluded)", result.GrossFils)
	}
	if result.FeeFils != feeInside {
		t.Errorf("FeeFils = %d, want %d", result.FeeFils, feeInside)
	}
	if result.EventCount != 1 {
		t.Errorf("EventCount = %d, want 1", result.EventCount)
	}
}

// YA: this one also covers two concurrent closes for the same day. don't delete.
func TestCloseBatch_IdempotentReClose(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 5000, start.Add(time.Hour))

	first, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("first CloseBatch: %v", err)
	}
	if first.AlreadyClosed {
		t.Fatal("first CloseBatch should not report AlreadyClosed")
	}

	lineCountAfterFirst := countRows(t, pool, `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, first.BatchID)
	eventCountAfterFirst := countRows(t, pool, `SELECT count(*) FROM transaction_events WHERE settlement_batch_id = $1`, first.BatchID)

	second, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("second CloseBatch: %v", err)
	}
	if !second.AlreadyClosed {
		t.Fatal("second CloseBatch on an already-closed batch must report AlreadyClosed = true")
	}
	if second.BatchID != first.BatchID || second.GrossFils != first.GrossFils || second.FeeFils != first.FeeFils || second.NetPayoutFils != first.NetPayoutFils {
		t.Errorf("second CloseBatch figures diverged from the first: %+v vs %+v", second, first)
	}

	lineCountAfterSecond := countRows(t, pool, `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, first.BatchID)
	eventCountAfterSecond := countRows(t, pool, `SELECT count(*) FROM transaction_events WHERE settlement_batch_id = $1`, first.BatchID)
	batchRowCount := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`, merchantID, businessDate)

	if lineCountAfterSecond != lineCountAfterFirst {
		t.Errorf("scheme_export_lines count changed on re-close: %d -> %d", lineCountAfterFirst, lineCountAfterSecond)
	}
	if eventCountAfterSecond != eventCountAfterFirst {
		t.Errorf("batched transaction_events count changed on re-close: %d -> %d", eventCountAfterFirst, eventCountAfterSecond)
	}
	if batchRowCount != 1 {
		t.Errorf("expected exactly one settlement_batches row for (merchant, date), got %d", batchRowCount)
	}
}

func TestCloseBatch_EmptyBatchStillCreated(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 3, 17, 0, 0, 0, 0, time.UTC)

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch on a merchant with zero events: %v", err)
	}
	if result.AlreadyClosed {
		t.Fatal("an empty batch on its first close must not report AlreadyClosed")
	}
	if result.GrossFils != 0 || result.FeeFils != 0 || result.NetPayoutFils != 0 {
		t.Errorf("expected all-zero figures for an empty batch, got %+v", result)
	}

	batchRowCount := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2 AND status = 'closed'`, merchantID, businessDate)
	if batchRowCount != 1 {
		t.Errorf("expected exactly one closed settlement_batches row for an empty batch, got %d", batchRowCount)
	}
	lineCount := countRows(t, pool, `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, result.BatchID)
	if lineCount != 0 {
		t.Errorf("expected zero scheme_export_lines for an empty batch, got %d", lineCount)
	}
}

// TestCloseBatch_FeePerEventThenSummed verifies fee is recomputed PER
// EVENT then summed — matching what capture.ts would have posted for the
// same events — never ApplyRateFils applied once to the pre-summed total
// (which can legitimately diverge on adversarial inputs).
func TestCloseBatch_FeePerEventThenSummed(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 3, 18, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// Two partial-capture events against the SAME transaction, same
	// business day, amounts chosen so per-event rounding and
	// round-the-sum-once rounding could plausibly diverge.
	txnID, fee1 := insertCaptureEvent(t, pool, merchantID, mdrBps, 4747, start.Add(1*time.Hour))
	fee2 := insertAdditionalCaptureEvent(t, pool, merchantID, txnID, mdrBps, 3331, start.Add(2*time.Hour))

	expectedFee := fee1 + fee2
	expectedGross := money.Fils(4747 + 3331)

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if result.GrossFils != expectedGross {
		t.Errorf("GrossFils = %d, want %d", result.GrossFils, expectedGross)
	}
	if result.FeeFils != expectedFee {
		t.Errorf("FeeFils = %d, want %d (sum of the exact per-event fees capture-time would have posted)", result.FeeFils, expectedFee)
	}

	// Cross-check directly against what was actually posted to
	// platform_fee_revenue for these events at "capture time" (the
	// ledger_entries this test inserted to simulate capture.ts).
	var ledgerFeeSum int64
	err = pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'platform_fee_revenue' AND transaction_id = $2
	`, merchantID, txnID).Scan(&ledgerFeeSum)
	if err != nil {
		t.Fatalf("query ledger fee sum: %v", err)
	}
	if money.Fils(ledgerFeeSum) != result.FeeFils {
		t.Errorf("CloseBatch's recomputed FeeFils (%d) does not match the sum of platform_fee_revenue credits capture-time posted (%d)", result.FeeFils, ledgerFeeSum)
	}
}

// MK: negatives not tested because they can't happen
func TestTruncateToSchemeAmount(t *testing.T) {
	cases := []struct {
		in, want money.Fils
	}{
		{4747, 4740},
		{4750, 4750},
		{4749, 4740},
		{0, 0},
		{9, 0},
		{10, 10},
	}
	for _, tc := range cases {
		got := TruncateToSchemeAmount(tc.in)
		if got != tc.want {
			t.Errorf("TruncateToSchemeAmount(%d) = %d, want %d", tc.in, got, tc.want)
		}
		if int64(got)%10 != 0 {
			t.Errorf("TruncateToSchemeAmount(%d) = %d is not a multiple of 10", tc.in, got)
		}
	}
}

func TestCloseBatch_SchemeExportLineTruncation(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 19, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	insertCaptureEvent(t, pool, merchantID, mdrBps, 4747, start.Add(time.Hour))

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var exportedAmount int64
	err = pool.QueryRow(context.Background(), `
		SELECT amount_fils FROM scheme_export_lines WHERE settlement_batch_id = $1
	`, result.BatchID).Scan(&exportedAmount)
	if err != nil {
		t.Fatalf("query scheme_export_lines: %v", err)
	}
	if exportedAmount != 4740 {
		t.Errorf("scheme_export_lines.amount_fils = %d, want 4740 (4747 truncated to the nearest 10 fils)", exportedAmount)
	}
}

// TestCloseAndPayout_MerchantBalancesIncremental verifies
// merchant_balances is maintained incrementally through close+payout: it
// gains net_payout_fils at close, then loses the same amount at payout,
// netting to zero once both steps have run in the same pass — exactly
// the arithmetic internal/balances describes.
func TestCloseAndPayout_MerchantBalancesIncremental(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour))

	closeResult, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closeResult.NetPayoutFils <= 0 {
		t.Fatalf("expected a positive net payout to exercise the balance delta, got %d", closeResult.NetPayoutFils)
	}

	var afterClose int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&afterClose)
	if err != nil {
		t.Fatalf("query merchant_balances after close: %v", err)
	}
	if money.Fils(afterClose) != closeResult.NetPayoutFils {
		t.Errorf("cached_payable_fils after close = %d, want %d (the batch's net_payout_fils)", afterClose, closeResult.NetPayoutFils)
	}

	payoutResult, err := PayoutBatch(context.Background(), pool, closeResult.BatchID)
	if err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if payoutResult.AlreadyPaid || payoutResult.NotClosed {
		t.Fatalf("unexpected payout outcome: %+v", payoutResult)
	}

	var afterPayout int64
	var lastBatchID uuid.UUID
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils, last_settlement_batch_id FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&afterPayout, &lastBatchID)
	if err != nil {
		t.Fatalf("query merchant_balances after payout: %v", err)
	}
	if afterPayout != 0 {
		t.Errorf("cached_payable_fils after close+payout = %d, want 0 (net-zero once paid)", afterPayout)
	}
	if lastBatchID != closeResult.BatchID {
		t.Errorf("last_settlement_batch_id = %s, want %s", lastBatchID, closeResult.BatchID)
	}

	// Ledger legs for the payout must exist and balance.
	var payoutLegCount int
	err = pool.QueryRow(context.Background(), `
		SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1
	`, closeResult.BatchID).Scan(&payoutLegCount)
	if err != nil {
		t.Fatalf("query payout ledger legs: %v", err)
	}
	if payoutLegCount != 2 {
		t.Errorf("expected exactly 2 ledger_entries legs for the payout, got %d", payoutLegCount)
	}

	var batchStatus string
	err = pool.QueryRow(context.Background(), `SELECT status FROM settlement_batches WHERE id = $1`, closeResult.BatchID).Scan(&batchStatus)
	if err != nil {
		t.Fatalf("query batch status: %v", err)
	}
	if batchStatus != "paid" {
		t.Errorf("batch status = %q, want %q", batchStatus, "paid")
	}
}

func TestPayoutBatch_IdempotentRePay(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 6000, start.Add(time.Hour))

	closeResult, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	first, err := PayoutBatch(context.Background(), pool, closeResult.BatchID)
	if err != nil {
		t.Fatalf("first PayoutBatch: %v", err)
	}

	second, err := PayoutBatch(context.Background(), pool, closeResult.BatchID)
	if err != nil {
		t.Fatalf("second PayoutBatch: %v", err)
	}
	if !second.AlreadyPaid {
		t.Fatal("second PayoutBatch on an already-paid batch must report AlreadyPaid = true")
	}
	if first.NetPayoutFils != second.NetPayoutFils {
		t.Errorf("payout figures diverged across idempotent re-pay: %d vs %d", first.NetPayoutFils, second.NetPayoutFils)
	}

	legCount := countRows(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1`, closeResult.BatchID)
	if legCount != 2 {
		t.Errorf("expected exactly 2 payout ledger legs after a re-pay attempt (no duplicates), got %d", legCount)
	}
}

// TestPayoutBatch_MissingBalanceRowSeededFromClosedBatches pays out a closed
// batch whose merchant has no merchant_balances row, the state the seed
// leaves every merchant in. The payout must still reach the cache, starting
// from the merchant's other closed, unpaid batches, so that once the next
// day closes the cache agrees with the ledger.
func TestPayoutBatch_MissingBalanceRowSeededFromClosedBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 3, 22, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start1.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 4000, start2.Add(time.Hour))

	first, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day 1: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM merchant_balances WHERE merchant_id = $1`, merchantID); err != nil {
		t.Fatalf("drop the balance row: %v", err)
	}

	if _, err := PayoutBatch(ctx, pool, first.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("query merchant_balances after payout (the payout never reached the cache): %v", err)
	}
	if cached != 0 {
		t.Errorf("cached_payable_fils after payout = %d, want 0 (no other batch closed and unpaid)", cached)
	}

	// Day 2's capture was already in the ledger at payout time; its close
	// must bring the cache to the ledger figure, not past it.
	if _, err := CloseBatch(ctx, pool, merchantID, day2); err != nil {
		t.Fatalf("CloseBatch day 2: %v", err)
	}
	var ledger int64
	err = pool.QueryRow(ctx, `
		SELECT (SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1),
		       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&cached, &ledger)
	if err != nil {
		t.Fatalf("query cache and ledger after day 2 close: %v", err)
	}
	if cached != 3900 || ledger != 3900 {
		t.Errorf("after day 2 close cached = %d, ledger = %d, want both 3900 (4000 less its 100 fee)", cached, ledger)
	}
}

// TestCloseBatch_MissingBalanceRowSeededFromClosedBatches is the daily
// order: RunDailyBatch closes before it pays, so for a merchant with closed,
// unpaid batches and no merchant_balances row the close creates the row.
// It must count those batches, or the later payout drives the cache
// negative while money is still owed.
func TestCloseBatch_MissingBalanceRowSeededFromClosedBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 3, 26, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	day3 := day1.AddDate(0, 0, 2)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 6000, start1.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 15000, start2.Add(time.Hour))

	first, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day 1: %v", err)
	}
	second, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day 2: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM merchant_balances WHERE merchant_id = $1`, merchantID); err != nil {
		t.Fatalf("drop the balance row: %v", err)
	}

	readCache := func() int64 {
		t.Helper()
		var cached int64
		err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
		if err != nil {
			t.Fatalf("query merchant_balances: %v", err)
		}
		return cached
	}

	// Day 3 has no captures: an empty batch that still creates the row.
	if _, err := CloseBatch(ctx, pool, merchantID, day3); err != nil {
		t.Fatalf("CloseBatch day 3: %v", err)
	}
	if got, want := readCache(), int64(first.NetPayoutFils+second.NetPayoutFils); got != want {
		t.Errorf("cached_payable_fils after empty close = %d, want %d (days 1 and 2 closed and unpaid)", got, want)
	}

	if _, err := PayoutBatch(ctx, pool, second.BatchID); err != nil {
		t.Fatalf("PayoutBatch day 2: %v", err)
	}
	if got, want := readCache(), int64(first.NetPayoutFils); got != want {
		t.Errorf("cached_payable_fils after paying day 2 = %d, want %d (day 1 still closed and unpaid)", got, want)
	}
}

// TestCloseBatchNetPayoutIsWholeFils pins what CloseBatch promises about
// the payout figure: the BD amount the payout instruction quotes is
// converted back to the column's own unit before it is stored, so
// settlement_batches.net_payout_fils is always a whole number of fils, and
// always the same figure the caller was handed.
// FH 2026-08-21: asked claude for an edge case, it said 13333 exercises the float rounding path. good enough
func TestCloseBatchNetPayoutIsWholeFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 23, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	insertCaptureEvent(t, pool, merchantID, mdrBps, 13333, start.Add(time.Hour))

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var storedText string
	err = pool.QueryRow(context.Background(), `
		SELECT net_payout_fils::text FROM settlement_batches WHERE id = $1
	`, result.BatchID).Scan(&storedText)
	if err != nil {
		t.Fatalf("query settlement_batches: %v", err)
	}
	if strings.Contains(storedText, ".") {
		t.Errorf("net_payout_fils = %q, want a whole number of fils with no fractional part", storedText)
	}
	if storedText != strconv.FormatInt(int64(result.NetPayoutFils), 10) {
		t.Errorf("stored net_payout_fils = %q, want %d (the figure CloseBatch returned)", storedText, result.NetPayoutFils)
	}
}

// One merchant whose batch cannot close must not stop the merchants after
// it: the daily run settles the rest and returns an error naming the
// failing merchant. runMerchants is RunDailyBatch's own merchant loop, run
// here on just the two test merchants, failing first, so the test leaves
// every other merchant in the shared test database alone.
func TestRunDailyBatch_MerchantErrorDoesNotStopOthers(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250

	failing := insertActiveMerchant(t, pool, mdrBps)
	healthy := insertActiveMerchant(t, pool, mdrBps)
	// Its capture is left unsettled, so keep the merchant out of every later
	// all-merchant run.
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `UPDATE merchants SET status = 'suspended' WHERE id = $1`, failing); err != nil {
			t.Errorf("suspend failing merchant: %v", err)
		}
	})

	businessDate := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	refuseBatchInsert(t, pool, failing, businessDate)
	insertCaptureEvent(t, pool, failing, mdrBps, 1000, start.Add(time.Hour))
	insertCaptureEvent(t, pool, healthy, mdrBps, 4750, start.Add(time.Hour))

	report, err := runMerchants(ctx, pool, businessDate, []uuid.UUID{failing, healthy})
	if err == nil || !strings.Contains(err.Error(), failing.String()) {
		t.Errorf("runMerchants error = %v, want one naming merchant %s", err, failing)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1`, failing); n != 0 {
		t.Errorf("failing merchant has %d batch row(s), want 0 after the rollback", n)
	}

	if len(report.MerchantResults) != 1 || report.MerchantResults[0].MerchantID != healthy || report.MerchantResults[0].GrossFils != 4750 {
		t.Fatalf("report = %+v, want one result for the healthy merchant with gross 4750", report.MerchantResults)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1 AND status = 'paid'`, healthy); n != 1 {
		t.Errorf("healthy merchant has %d paid batch(es), want 1", n)
	}
}

// refuseBatchInsert makes CloseBatch fail for one merchant and business date
// only: a test-only trigger rejects that merchant's settlement_batches insert
// for that date, so its close rolls back. Dropped when the test ends.
func refuseBatchInsert(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) {
	t.Helper()
	ctx := context.Background()
	// DDL takes no bind parameters; the id and date come from the test itself.
	name := "test_refuse_batch_" + strings.ReplaceAll(merchantID.String(), "-", "")
	_, err := pool.Exec(ctx, `CREATE FUNCTION `+name+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test: batch insert refused'; END $$`)
	if err != nil {
		t.Fatalf("refuseBatchInsert: create function: %v", err)
	}
	_, err = pool.Exec(ctx, `CREATE TRIGGER `+name+` BEFORE INSERT ON settlement_batches FOR EACH ROW
		WHEN (NEW.merchant_id = '`+merchantID.String()+`' AND NEW.batch_date = '`+businessDate.Format("2006-01-02")+`')
		EXECUTE FUNCTION `+name+`()`)
	if err != nil {
		t.Fatalf("refuseBatchInsert: create trigger: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+name+` ON settlement_batches`); err != nil {
			t.Errorf("drop trigger: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+name+`()`); err != nil {
			t.Errorf("drop function: %v", err)
		}
	})
}

func TestCloseBatch_RefusesBusinessDayThatHasNotEnded(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	today := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	todayStart, todayEnd := BusinessDayWindow(today)
	yesterday := today.AddDate(0, 0, -1)
	tomorrow := today.AddDate(0, 0, 1)

	// 10:00 in Bahrain on 20 March: the 20th is still running.
	fixedNow := todayStart.Add(10 * time.Hour)
	realNow := now
	now = func() time.Time { return fixedNow }
	t.Cleanup(func() { now = realNow })

	insertCaptureEvent(t, pool, merchantID, mdrBps, 4750, todayStart.Add(time.Hour))
	yesterdayStart, _ := BusinessDayWindow(yesterday)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 3000, yesterdayStart.Add(time.Hour))

	for _, date := range []time.Time{today, tomorrow} {
		_, err := CloseBatch(context.Background(), pool, merchantID, date)
		if !errors.Is(err, ErrBusinessDayNotOver) {
			t.Errorf("CloseBatch(%s) err = %v, want ErrBusinessDayNotOver", date.Format("2006-01-02"), err)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`, merchantID, date); n != 0 {
			t.Errorf("CloseBatch(%s) left %d settlement_batches row(s), want 0", date.Format("2006-01-02"), n)
		}
	}
	if n := countRows(t, pool, `SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NOT NULL AND te.occurred_at >= $2`, merchantID, todayStart); n != 0 {
		t.Errorf("%d of today's capture events were batched by a refused close, want 0", n)
	}

	closed, err := CloseBatch(context.Background(), pool, merchantID, yesterday)
	if err != nil {
		t.Fatalf("CloseBatch(yesterday): %v", err)
	}
	if closed.AlreadyClosed || closed.GrossFils != 3000 {
		t.Errorf("CloseBatch(yesterday) = %+v, want a fresh close of 3000 fils", closed)
	}

	fixedNow = todayEnd.Add(-time.Nanosecond)
	if _, err := CloseBatch(context.Background(), pool, merchantID, today); !errors.Is(err, ErrBusinessDayNotOver) {
		t.Errorf("CloseBatch(today) just before Bahrain midnight err = %v, want ErrBusinessDayNotOver", err)
	}

	// At Bahrain midnight the 20th is over and closes, picking up its capture.
	fixedNow = todayEnd
	closed, err = CloseBatch(context.Background(), pool, merchantID, today)
	if err != nil {
		t.Fatalf("CloseBatch(today) at Bahrain midnight: %v", err)
	}
	if closed.GrossFils != 4750 {
		t.Errorf("CloseBatch(today) at Bahrain midnight GrossFils = %d, want 4750", closed.GrossFils)
	}
}

// insertJournaledCapture inserts one capture-type transaction_events row the
// way apps/api's capture.ts writes it, with the fee it posted in
// metadata.feeFils, plus the ledger legs it posted for that event.
func insertJournaledCapture(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, eventType string, amountFils, feeFils money.Fils, occurredAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
		VALUES ($1, $2, $3, 'system', jsonb_build_object('feeFils', $4::bigint), $5)
	`, txnID, eventType, int64(amountFils), int64(feeFils), occurredAt)
	if err != nil {
		t.Fatalf("insertJournaledCapture: insert transaction_events: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $6, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $6, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'debit',  $5, $6, 'capture: MDR fee'),
		  ($1, $2, $3, 'platform_fee_revenue', 'credit', $5, $6, 'capture: MDR fee')
	`, uuid.New(), merchantID, txnID, int64(amountFils), int64(feeFils), occurredAt)
	if err != nil {
		t.Fatalf("insertJournaledCapture: insert ledger legs: %v", err)
	}
}

// TestCloseBatch_PaysTheFeeJournaledAtCapture covers the night the platform
// volume counter crosses the tier threshold between capture and close: the
// captures were journaled at the full rate, so the batch must charge that
// fee, and its net payout must equal the merchant_payable the ledger holds.
func TestCloseBatch_PaysTheFeeJournaledAtCapture(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250

	var originalProcessed int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&originalProcessed); err != nil {
		t.Fatalf("read platform_stats: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, originalProcessed); err != nil {
			t.Errorf("restore platform_stats: %v", err)
		}
	})

	businessDate := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	for _, tc := range []struct {
		name        string
		discountBps int64
		// feeNetOfDiscount: feeFils already has the discount taken off and
		// no rebate is posted, the form db/seed/fixtures/transactions.ts
		// writes. Otherwise discountAdjustment.ts credits a rebate after
		// each capture, except the one at index rebateFailed (-1: none),
		// whose adjustment call threw after the capture committed.
		feeNetOfDiscount bool
		rebateFailed     int
	}{
		{"no negotiated discount", 0, false, -1},
		{"negotiated discount rebated after capture", 1250, false, -1},
		{"negotiated discount already in the journaled fee", 1250, true, -1},
		{"first partial capture's rebate never posted", 1250, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			merchantID := insertActiveMerchant(t, pool, mdrBps)
			if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = $2 WHERE id = $1`, merchantID, tc.discountBps); err != nil {
				t.Fatalf("set negotiated_discount_bps: %v", err)
			}

			// Captured below the tier threshold: full 250 bps journaled.
			// One full capture, and one order captured in two parts.
			var fullTxn, splitTxn uuid.UUID
			for _, id := range []*uuid.UUID{&fullTxn, &splitTxn} {
				if err := pool.QueryRow(ctx, `
					INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
					VALUES ($1, 'captured', 100000, 100000, $2, $3) RETURNING id
				`, merchantID, "acq-ref-"+uuid.New().String(), start.Add(time.Hour)).Scan(id); err != nil {
					t.Fatalf("insert transaction: %v", err)
				}
			}
			captures := []struct {
				txnID     uuid.UUID
				eventType string
				amount    money.Fils
			}{
				{fullTxn, "captured", 100000},
				{splitTxn, "partially_captured", 40000},
				{splitTxn, "captured", 60000},
			}
			for i, c := range captures {
				fee := money.ApplyRateFils(c.amount, mdrBps)
				rebate := money.ApplyRateFils(fee, tc.discountBps)
				if tc.feeNetOfDiscount {
					fee -= rebate
				}
				at := start.Add(time.Duration(i+1) * time.Hour)
				insertJournaledCapture(t, pool, merchantID, c.txnID, c.eventType, c.amount, fee, at)
				if !tc.feeNetOfDiscount && i != tc.rebateFailed && rebate > 0 {
					if _, err := pool.Exec(ctx, `
						INSERT INTO ledger_entries
						  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
						VALUES
						  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'capture: negotiated discount adjustment'),
						  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: negotiated discount adjustment')
					`, uuid.New(), merchantID, c.txnID, int64(rebate), at); err != nil {
						t.Fatalf("insert discount adjustment: %v", err)
					}
				}
			}

			// Another merchant's close earlier that night pushed the
			// platform past the threshold before this batch closes.
			if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2000000000 WHERE id = 1`); err != nil {
				t.Fatalf("set platform_stats: %v", err)
			}

			result, err := CloseBatch(ctx, pool, merchantID, businessDate)
			if err != nil {
				t.Fatalf("CloseBatch: %v", err)
			}

			var ledgerPayable int64
			if err := pool.QueryRow(ctx, `
				SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_fils ELSE -amount_fils END), 0)
				  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
			`, merchantID).Scan(&ledgerPayable); err != nil {
				t.Fatalf("sum merchant_payable: %v", err)
			}
			if result.GrossFils != 200000 {
				t.Errorf("GrossFils = %d, want 200000", result.GrossFils)
			}
			if int64(result.NetPayoutFils) != ledgerPayable {
				t.Errorf("NetPayoutFils = %d, want %d (the merchant_payable journaled at capture); FeeFils = %d", result.NetPayoutFils, ledgerPayable, result.FeeFils)
			}
		})
	}
}

// insertPostedCredit writes what apps/api's admin/credits.ts postCreditToLedger
// leaves behind for a posted manual credit: the credit_requests row, the
// merchant_credit_contra/merchant_payable base pair, the platform_fee_revenue/
// merchant_payable reversal pair when feeReversalFils > 0, and the cache bump.
func insertPostedCredit(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, baseFils, feeReversalFils int64, occurredAt, postedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var adminID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO admin_users (email, password_hash, display_name, role)
		VALUES ($1, 'x', 'settlement credit test', 'finance')
		RETURNING id
	`, "credit-"+uuid.New().String()+"@test.invalid").Scan(&adminID)
	if err != nil {
		t.Fatalf("insertPostedCredit: admin user: %v", err)
	}
	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO credit_requests
		  (merchant_id, requested_by_admin_user_id, requested_by_display_name, reason_code,
		   base_amount_fils, fee_reversal_fils, effective_date, requires_approval, status, posted_at, ledger_entry_group_id)
		VALUES ($1, $2, 'settlement credit test', 'goodwill', $3, $4, $5::date, false, 'posted', $6, $7)
	`, merchantID, adminID, baseFils, feeReversalFils, occurredAt, postedAt, groupID)
	if err != nil {
		t.Fatalf("insertPostedCredit: credit_requests: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_credit_contra', 'debit',  $3, $4, 'manual credit: base'),
		       ($1, $2, 'merchant_payable',       'credit', $3, $4, 'manual credit: base')
	`, groupID, merchantID, baseFils, occurredAt)
	if err != nil {
		t.Fatalf("insertPostedCredit: base legs: %v", err)
	}
	if feeReversalFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES ($1, $2, 'platform_fee_revenue', 'debit',  $3, $4, 'manual credit: MDR reversal'),
			       ($1, $2, 'merchant_payable',     'credit', $3, $4, 'manual credit: MDR reversal')
		`, groupID, merchantID, feeReversalFils, occurredAt)
		if err != nil {
			t.Fatalf("insertPostedCredit: reversal legs: %v", err)
		}
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils
	`, merchantID, baseFils+feeReversalFils)
	if err != nil {
		t.Fatalf("insertPostedCredit: balance cache: %v", err)
	}
}

// A posted manual credit is owed to the merchant on merchant_payable, and the
// batch payout is the only thing that ever pays merchant_payable out. The
// first close after the credit posts must carry it, and no later close may
// carry it again.
func TestCloseBatch_PaysPostedManualCreditsExactlyOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	nextDay := day.AddDate(0, 0, 1)
	dayStart, dayEnd := BusinessDayWindow(day)

	_, feeFils := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, dayStart.Add(time.Hour))
	// Booked against an earlier date, posted during the day: still paid now.
	insertPostedCredit(t, pool, merchantID, 1500, 0, dayStart.AddDate(0, 0, -5), dayStart.Add(2*time.Hour))
	insertPostedCredit(t, pool, merchantID, 700, 18, dayStart, dayStart.Add(3*time.Hour))
	// Posted after the day ended: belongs to the next day's batch.
	insertPostedCredit(t, pool, merchantID, 400, 0, dayStart, dayEnd.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch(day): %v", err)
	}
	wantNet := money.Fils(10000) - feeFils + 1500 + 718
	if closed.NetPayoutFils != wantNet {
		t.Errorf("CloseBatch(day) NetPayoutFils = %d, want %d (captures net plus the two credits posted that day)", closed.NetPayoutFils, wantNet)
	}
	if closed.NetPayoutFils != closed.GrossFils-closed.FeeFils {
		t.Errorf("CloseBatch(day) net %d != gross %d - fee %d", closed.NetPayoutFils, closed.GrossFils, closed.FeeFils)
	}
	paid, err := PayoutBatch(ctx, pool, closed.BatchID)
	if err != nil {
		t.Fatalf("PayoutBatch(day): %v", err)
	}
	if paid.NetPayoutFils != wantNet {
		t.Errorf("PayoutBatch(day) paid %d, want %d", paid.NetPayoutFils, wantNet)
	}

	again, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch(day) rerun: %v", err)
	}
	if !again.AlreadyClosed || again.NetPayoutFils != wantNet {
		t.Errorf("CloseBatch(day) rerun = %+v, want AlreadyClosed with net %d", again, wantNet)
	}

	next, err := CloseBatch(ctx, pool, merchantID, nextDay)
	if err != nil {
		t.Fatalf("CloseBatch(nextDay): %v", err)
	}
	if next.NetPayoutFils != 400 {
		t.Errorf("CloseBatch(nextDay) NetPayoutFils = %d, want 400 (only the credit posted after day ended)", next.NetPayoutFils)
	}
	if _, err := PayoutBatch(ctx, pool, next.BatchID); err != nil {
		t.Fatalf("PayoutBatch(nextDay): %v", err)
	}

	third, err := CloseBatch(ctx, pool, merchantID, nextDay.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("CloseBatch(third day): %v", err)
	}
	if third.NetPayoutFils != 0 {
		t.Errorf("CloseBatch(third day) NetPayoutFils = %d, want 0 (every credit already paid)", third.NetPayoutFils)
	}

	var cached int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached); err != nil {
		t.Fatalf("query merchant_balances: %v", err)
	}
	if cached != 0 {
		t.Errorf("cached_payable_fils after every batch paid = %d, want 0", cached)
	}
	var payable int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&payable); err != nil {
		t.Fatalf("sum merchant_payable: %v", err)
	}
	if payable != 0 {
		t.Errorf("merchant_payable ledger balance after every batch paid = %d, want 0", payable)
	}
}

// TestCloseBatch_SubtractsRefundsInWindow pins the payout formula once
// refunds exist: net = captures - fees - refunds + reversed fees, and the
// batch's net matches the merchant_payable movement the ledger recorded for
// the same day, down to the fils.
func TestCloseBatch_SubtractsRefundsInWindow(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// 10.000 BD captured, fee 250 fils. 4.000 BD refunded the same day,
	// reversing 100 fils of fee.
	txnID, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour))
	if fee != 250 {
		t.Fatalf("capture fee = %d, want 250", fee)
	}
	refundID := insertRefund(t, pool, merchantID, txnID, "succeeded", 4000, 100, start.Add(2*time.Hour))
	// A failed refund moved no money, and one from the next day had not
	// happened yet when this day closed: neither may count here.
	insertRefund(t, pool, merchantID, txnID, "failed", 1000, 0, start.Add(3*time.Hour))
	laterRefundID := insertRefund(t, pool, merchantID, txnID, "succeeded", 500, 10, start.AddDate(0, 0, 1).Add(time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if result.GrossFils != 6000 {
		t.Errorf("GrossFils = %d, want 6000 (10000 captured - 4000 refunded)", result.GrossFils)
	}
	if result.FeeFils != 150 {
		t.Errorf("FeeFils = %d, want 150 (250 charged - 100 reversed)", result.FeeFils)
	}
	if result.NetPayoutFils != 5850 {
		t.Errorf("NetPayoutFils = %d, want 5850 (10000 - 250 - 4000 + 100)", result.NetPayoutFils)
	}

	var ledgerNet int64
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
		   AND occurred_at >= $2 AND occurred_at < $3
	`, merchantID, start, start.AddDate(0, 0, 1)).Scan(&ledgerNet)
	if err != nil {
		t.Fatalf("query ledger merchant_payable: %v", err)
	}
	if money.Fils(ledgerNet) != result.NetPayoutFils {
		t.Errorf("ledger merchant_payable for the day = %d, batch net = %d; they must tie", ledgerNet, result.NetPayoutFils)
	}

	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, result.BatchID); n != 1 {
		t.Errorf("the in-window refund was not marked with the batch id")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE id = $1 AND settlement_batch_id IS NULL`, laterRefundID); n != 1 {
		t.Errorf("the next day's refund was claimed by this batch")
	}
}

// TestCloseBatch_RefundAfterPaidBatchLandsInNextBatch: a paid batch is
// never reopened. A refund made after the capture's batch was paid is
// deducted from the batch of the business day the refund happened, the
// same day its ledger legs are dated.
func TestCloseBatch_RefundAfterPaidBatchLandsInNextBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day1 := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start1.Add(time.Hour))
	first, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day 1: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, first.BatchID); err != nil {
		t.Fatalf("PayoutBatch day 1: %v", err)
	}
	if first.NetPayoutFils != 9750 {
		t.Fatalf("day 1 NetPayoutFils = %d, want 9750", first.NetPayoutFils)
	}

	// Day 2: the day-1 sale is partly refunded, and a new 6.000 BD sale
	// comes in (fee 150 fils).
	refundID := insertRefund(t, pool, merchantID, txnID, "succeeded", 4000, 100, start2.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 6000, start2.Add(2*time.Hour))

	again, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("re-CloseBatch day 1: %v", err)
	}
	if !again.AlreadyClosed || again.NetPayoutFils != 9750 {
		t.Errorf("paid day-1 batch changed: AlreadyClosed=%v NetPayoutFils=%d, want true and 9750", again.AlreadyClosed, again.NetPayoutFils)
	}

	second, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day 2: %v", err)
	}
	if second.GrossFils != 2000 || second.FeeFils != 50 || second.NetPayoutFils != 1950 {
		t.Errorf("day 2 batch = gross %d, fee %d, net %d; want 2000, 50, 1950 (6000 - 150 - 4000 + 100)",
			second.GrossFils, second.FeeFils, second.NetPayoutFils)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, second.BatchID); n != 1 {
		t.Errorf("the day-2 refund was not claimed by the day-2 batch")
	}
}

// merchantPayableLedger is the merchant's lifetime merchant_payable balance
// in the ledger, credits minus debits.
func merchantPayableLedger(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) money.Fils {
	t.Helper()
	var net int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&net)
	if err != nil {
		t.Fatalf("merchantPayableLedger: %v", err)
	}
	return money.Fils(net)
}

func cachedPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) money.Fils {
	t.Helper()
	var cached int64
	err := pool.QueryRow(context.Background(), `
		SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1
	`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("cachedPayable: %v", err)
	}
	return money.Fils(cached)
}

func closeAndPay(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) BatchResult {
	t.Helper()
	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch %s: %v", businessDate.Format("2006-01-02"), err)
	}
	if _, err := PayoutBatch(context.Background(), pool, result.BatchID); err != nil {
		t.Fatalf("PayoutBatch %s: %v", businessDate.Format("2006-01-02"), err)
	}
	return result
}

// TestCloseBatch_RefundBeyondDayNetCarriesForward: a refund bigger than
// what the merchant earned that day must not close a negative batch,
// because a payout has no leg to collect money back and the shortfall
// would be written off. The refund stays unclaimed and comes off the next
// batch that can carry it, so nothing is lost and the cache ends equal to
// the ledger.
func TestCloseBatch_RefundBeyondDayNetCarriesForward(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	day1 := time.Date(2026, 3, 27, 0, 0, 0, 0, time.UTC)
	day2, day3 := day1.AddDate(0, 0, 1), day1.AddDate(0, 0, 2)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)
	start3, _ := BusinessDayWindow(day3)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start1.Add(time.Hour))
	if got := closeAndPay(t, pool, merchantID, day1).NetPayoutFils; got != 9750 {
		t.Fatalf("day 1 NetPayoutFils = %d, want 9750", got)
	}

	// Day 2: a 4.000 BD refund (100 fils fee reversed) and no sales.
	refundID := insertRefund(t, pool, merchantID, txnID, "succeeded", 4000, 100, start2.Add(time.Hour))
	second := closeAndPay(t, pool, merchantID, day2)
	if second.GrossFils != 0 || second.FeeFils != 0 || second.NetPayoutFils != 0 {
		t.Errorf("day 2 batch = gross %d, fee %d, net %d; want 0, 0, 0 (the refund carries)", second.GrossFils, second.FeeFils, second.NetPayoutFils)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE id = $1 AND settlement_batch_id IS NULL`, refundID); n != 1 {
		t.Errorf("the refund was claimed by a batch that could not carry it")
	}

	// Day 3: a 6.000 BD sale (150 fils fee) carries the refund.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 6000, start3.Add(time.Hour))
	third := closeAndPay(t, pool, merchantID, day3)
	if third.GrossFils != 2000 || third.FeeFils != 50 || third.NetPayoutFils != 1950 {
		t.Errorf("day 3 batch = gross %d, fee %d, net %d; want 2000, 50, 1950 (6000 - 150 - 4000 + 100)", third.GrossFils, third.FeeFils, third.NetPayoutFils)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE id = $1 AND settlement_batch_id = $2`, refundID, third.BatchID); n != 1 {
		t.Errorf("the carried refund was not claimed by the day-3 batch")
	}

	// Paid out in total: 9750 + 0 + 1950 = 11700 = 16000 - 400 - 4000 + 100.
	var paidOut int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable' AND description = 'settlement payout: batch paid'
	`, merchantID).Scan(&paidOut)
	if err != nil {
		t.Fatalf("sum payout legs: %v", err)
	}
	if paidOut != 11700 {
		t.Errorf("total paid out = %d, want 11700", paidOut)
	}
	if ledger, cache := merchantPayableLedger(t, pool, merchantID), cachedPayable(t, pool, merchantID); ledger != 0 || cache != 0 {
		t.Errorf("merchant_payable ledger = %d, cache = %d; want both 0 once everything is paid", ledger, cache)
	}
}

// TestPayoutBatch_RefusesNegativeNet: a negative net is money the merchant
// owes; marking the batch paid would write it off, so PayoutBatch refuses
// and leaves the batch, the ledger and the cache as they were.
func TestPayoutBatch_RefusesNegativeNet(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 3, 30, 0, 0, 0, 0, time.UTC)

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE settlement_batches SET net_payout_fils = -500 WHERE id = $1`, closed.BatchID); err != nil {
		t.Fatalf("force negative net: %v", err)
	}

	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err == nil {
		t.Fatal("PayoutBatch accepted a negative net payout")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM settlement_batches WHERE id = $1 AND status = 'closed'`, closed.BatchID); n != 1 {
		t.Errorf("batch left 'closed' state after a refused payout")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1`, closed.BatchID); n != 0 {
		t.Errorf("refused payout posted %d ledger legs", n)
	}
	if cache := cachedPayable(t, pool, merchantID); cache != 0 {
		t.Errorf("cached_payable_fils = %d after a refused payout, want 0", cache)
	}
}

// TestCloseBatch_RefundsStayWithTheirMerchant: two merchants refund in the
// same window; each batch takes only its own merchant's refunds.
func TestCloseBatch_RefundsStayWithTheirMerchant(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantA := insertActiveMerchant(t, pool, mdrBps)
	merchantB := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnA, _ := insertCaptureEvent(t, pool, merchantA, mdrBps, 10000, start.Add(time.Hour))
	txnB, _ := insertCaptureEvent(t, pool, merchantB, mdrBps, 5000, start.Add(time.Hour))
	refundA := insertRefund(t, pool, merchantA, txnA, "succeeded", 4000, 100, start.Add(2*time.Hour))
	refundB := insertRefund(t, pool, merchantB, txnB, "succeeded", 1000, 25, start.Add(2*time.Hour))

	a, err := CloseBatch(ctx, pool, merchantA, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch A: %v", err)
	}
	b, err := CloseBatch(ctx, pool, merchantB, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch B: %v", err)
	}

	if a.GrossFils != 6000 || a.FeeFils != 150 || a.NetPayoutFils != 5850 {
		t.Errorf("merchant A batch = gross %d, fee %d, net %d; want 6000, 150, 5850", a.GrossFils, a.FeeFils, a.NetPayoutFils)
	}
	if b.GrossFils != 4000 || b.FeeFils != 100 || b.NetPayoutFils != 3900 {
		t.Errorf("merchant B batch = gross %d, fee %d, net %d; want 4000, 100, 3900", b.GrossFils, b.FeeFils, b.NetPayoutFils)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE (id = $1 AND settlement_batch_id = $2) OR (id = $3 AND settlement_batch_id = $4)`, refundA, a.BatchID, refundB, b.BatchID); n != 2 {
		t.Errorf("each refund must be claimed by its own merchant's batch, got %d of 2", n)
	}
}

// TestCloseBatch_SeveralPartialRefundsOnOneSale: a sale refunded in three
// parts on the day it was made nets to zero, fee included. The reversals
// are the cumulative ones processRefund records: fee(3000) = 75,
// fee(6000) - fee(3000) = 75, fee(10000) - fee(6000) = 100.
func TestCloseBatch_SeveralPartialRefundsOnOneSale(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)

	businessDate := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 3000, 75, start.Add(2*time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 3000, 75, start.Add(3*time.Hour))
	insertRefund(t, pool, merchantID, txnID, "succeeded", 4000, 100, start.Add(4*time.Hour))

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if result.GrossFils != 0 || result.FeeFils != 0 || result.NetPayoutFils != 0 {
		t.Errorf("batch = gross %d, fee %d, net %d; want 0, 0, 0 for a fully refunded sale", result.GrossFils, result.FeeFils, result.NetPayoutFils)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refunds WHERE transaction_id = $1 AND settlement_batch_id = $2`, txnID, result.BatchID); n != 3 {
		t.Errorf("claimed %d of 3 partial refunds", n)
	}
	if ledger := merchantPayableLedger(t, pool, merchantID); ledger != result.NetPayoutFils {
		t.Errorf("merchant_payable ledger = %d, batch net = %d; they must tie", ledger, result.NetPayoutFils)
	}
}
