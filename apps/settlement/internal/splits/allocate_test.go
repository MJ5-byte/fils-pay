package splits

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// mustPool connects to DATABASE_URL or skips, the same contract as the
// settlement package's DB-backed tests.
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

// insertMerchant creates a test_mode merchant, so a later RunDailyBatch on
// the same database skips it; PayoutSplitBatch itself ignores test_mode.
func insertMerchant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', true)
		RETURNING id
	`, "splits-test-"+uuid.New().String()).Scan(&id)
	if err != nil {
		t.Fatalf("insertMerchant: %v", err)
	}
	return id
}

// TestPayoutSplitBatch_LegsMatchNetPayout pays a closed 1003-fil batch over
// the seed's 50/30/20 split and checks every fil of net_payout_fils reaches
// a child: the split rows, the parent's payout ledger legs and the parent's
// cached balance all move by exactly the batch's net payout.
func TestPayoutSplitBatch_LegsMatchNetPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const netPayout = 1003

	parentID := insertMerchant(t, pool)
	for _, w := range []int64{5000, 3000, 2000} {
		childID := insertMerchant(t, pool)
		_, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)
		`, parentID, childID, w)
		if err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, net_payout_fils, closed_at)
		VALUES ($1, DATE '2026-03-20', 'closed', $2, now())
		RETURNING id
	`, parentID, netPayout).Scan(&batchID)
	if err != nil {
		t.Fatalf("insert closed batch: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, $2, $3, now())
	`, parentID, netPayout, batchID)
	if err != nil {
		t.Fatalf("insert merchant balance: %v", err)
	}

	result, err := PayoutSplitBatch(ctx, pool, batchID)
	if err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}
	var sharesTotal int64
	for _, s := range result.Shares {
		sharesTotal += int64(s.AllocatedFils)
	}
	if sharesTotal != netPayout {
		t.Errorf("result shares sum to %d, want %d", sharesTotal, netPayout)
	}

	var splitRowsTotal, debitTotal, cached int64
	err = pool.QueryRow(ctx, `SELECT COALESCE(sum(allocated_fils), 0) FROM settlement_batch_splits WHERE settlement_batch_id = $1`, batchID).Scan(&splitRowsTotal)
	if err != nil {
		t.Fatalf("sum split rows: %v", err)
	}
	if splitRowsTotal != netPayout {
		t.Errorf("settlement_batch_splits sum to %d, want %d", splitRowsTotal, netPayout)
	}
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_fils), 0) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND merchant_id = $2
		   AND account_id = 'merchant_payable' AND direction = 'debit'
	`, batchID, parentID).Scan(&debitTotal)
	if err != nil {
		t.Fatalf("sum payout legs: %v", err)
	}
	if debitTotal != netPayout {
		t.Errorf("merchant_payable payout debits sum to %d, want %d", debitTotal, netPayout)
	}
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, parentID).Scan(&cached)
	if err != nil {
		t.Fatalf("read merchant balance: %v", err)
	}
	if cached != 0 {
		t.Errorf("parent cached_payable_fils after payout = %d, want 0", cached)
	}
}

// TestPayoutSplitBatch_MissingBalanceRowExcludesPaidBatch pays a split
// parent that has no merchant_balances row. PayoutSplitBatch marks the batch
// paid only after the cache update, so the batch is still 'closed' when the
// row is seeded: the seed must leave it out, keeping only the parent's other
// closed, unpaid batch.
func TestPayoutSplitBatch_MissingBalanceRowExcludesPaidBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	parentID := insertMerchant(t, pool)
	for _, w := range []int64{6000, 4000} {
		childID := insertMerchant(t, pool)
		_, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)
		`, parentID, childID, w)
		if err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}

	insertClosed := func(date string, netPayout int64) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		err := pool.QueryRow(ctx, `
			INSERT INTO settlement_batches (merchant_id, batch_date, status, net_payout_fils, closed_at)
			VALUES ($1, $2::date, 'closed', $3, now())
			RETURNING id
		`, parentID, date, netPayout).Scan(&id)
		if err != nil {
			t.Fatalf("insert closed batch: %v", err)
		}
		return id
	}
	paidID := insertClosed("2026-03-21", 1000)
	insertClosed("2026-03-22", 500)

	if _, err := PayoutSplitBatch(ctx, pool, paidID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}

	var cached int64
	err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, parentID).Scan(&cached)
	if err != nil {
		t.Fatalf("read merchant balance: %v", err)
	}
	if cached != 500 {
		t.Errorf("parent cached_payable_fils after payout = %d, want 500 (only the unpaid batch)", cached)
	}
}

// TestPayoutSplitBatch_BumpsLifetimePayoutEstimate pays a split parent's
// closed batch and checks the parent's lifetime payout estimate moves by the
// batch's net payout, as it does for a non-split merchant's payout.
func TestPayoutSplitBatch_BumpsLifetimePayoutEstimate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const netPayout = 1003

	parentID := insertMerchant(t, pool)
	for _, w := range []int64{5000, 3000, 2000} {
		childID := insertMerchant(t, pool)
		_, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)
		`, parentID, childID, w)
		if err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}
	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, net_payout_fils, closed_at)
		VALUES ($1, DATE '2026-03-21', 'closed', $2, now())
		RETURNING id
	`, parentID, netPayout).Scan(&batchID)
	if err != nil {
		t.Fatalf("insert closed batch: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, $2, $3, now())
	`, parentID, netPayout, batchID)
	if err != nil {
		t.Fatalf("insert merchant balance: %v", err)
	}

	if _, err := PayoutSplitBatch(ctx, pool, batchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}

	var got int64
	err = pool.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1`, parentID).Scan(&got)
	if err != nil {
		t.Fatalf("read estimate: %v", err)
	}
	if got != netPayout {
		t.Errorf("lifetime_net_payout_monitoring_estimate = %d, want %d", got, netPayout)
	}
}

// TestPayoutSplitBatch_NegativeNetLeavesLifetimePayoutEstimate pays a split
// parent's closed batch whose net is negative (money owed). The estimate is a
// running total of payouts, so it must not go down.
func TestPayoutSplitBatch_NegativeNetLeavesLifetimePayoutEstimate(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	parentID := insertMerchant(t, pool)
	for _, w := range []int64{6000, 4000} {
		childID := insertMerchant(t, pool)
		_, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)
		`, parentID, childID, w)
		if err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}
	_, err := pool.Exec(ctx, `UPDATE merchants SET lifetime_net_payout_monitoring_estimate = 700 WHERE id = $1`, parentID)
	if err != nil {
		t.Fatalf("seed estimate: %v", err)
	}
	var batchID uuid.UUID
	err = pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, net_payout_fils, closed_at)
		VALUES ($1, DATE '2026-03-22', 'closed', -500, now())
		RETURNING id
	`, parentID).Scan(&batchID)
	if err != nil {
		t.Fatalf("insert closed batch: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, -500, $2, now())
	`, parentID, batchID)
	if err != nil {
		t.Fatalf("insert merchant balance: %v", err)
	}

	_, _ = PayoutSplitBatch(ctx, pool, batchID) // whether it errors is not what this test pins

	var got int64
	err = pool.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1`, parentID).Scan(&got)
	if err != nil {
		t.Fatalf("read estimate: %v", err)
	}
	if got != 700 {
		t.Errorf("lifetime_net_payout_monitoring_estimate = %d, want 700 unchanged", got)
	}
}
