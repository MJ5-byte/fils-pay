package ledger

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
)

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

func insertActiveMerchant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false)
		RETURNING id
	`, "rebuild-test-"+uuid.New().String()).Scan(&id)
	if err != nil {
		t.Fatalf("insertActiveMerchant: %v", err)
	}
	return id
}

// postLedgerLeg inserts one balanced two-leg ledger_entries group touching
// merchant_payable on one side, mirroring the gross leg of a real capture.
func postLedgerLeg(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, direction string, amountFils int64) {
	t.Helper()
	groupID := uuid.New()
	other := "card_scheme_clearing"
	otherDirection := "debit"
	if direction == "debit" {
		otherDirection = "credit"
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable', $3, $4, now(), 'test leg'),
		  ($1, $2, $5, $6, $4, now(), 'test leg (other side)')
	`, groupID, merchantID, direction, amountFils, other, otherDirection)
	if err != nil {
		t.Fatalf("postLedgerLeg: %v", err)
	}
}

// insertBatch inserts one settlement batch for merchantID with the given
// status and net, daysAgo days before today so each call gets its own date.
func insertBatch(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, daysAgo int, status string, netFils int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
		VALUES ($1, current_date - $2::int, $3, $4, 0, $4,
		        CASE WHEN $3 = 'open' THEN NULL ELSE now() END,
		        CASE WHEN $3 = 'paid' THEN now() END)
		RETURNING id
	`, merchantID, daysAgo, status, netFils).Scan(&id)
	if err != nil {
		t.Fatalf("insertBatch: %v", err)
	}
	return id
}

// BHA-189: the cache holds closed, unpaid batch nets. A paid batch is out,
// an open one is not closed yet, and a capture's ledger legs wait for the
// close that adds them, so none of the three may count.
func TestRebuildMerchantBalance_SumsClosedUnpaidBatches(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertBatch(t, pool, merchantID, 4, "closed", 10000)
	insertBatch(t, pool, merchantID, 3, "closed", 5000)
	insertBatch(t, pool, merchantID, 2, "paid", 2000)
	insertBatch(t, pool, merchantID, 1, "open", 375)
	postLedgerLeg(t, pool, merchantID, "credit", 999)

	got, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got != 15000 {
		t.Errorf("RebuildMerchantBalance = %d, want 15000 (the two closed, unpaid batches)", got)
	}
}

func TestRebuildMerchantBalance_ZeroActivity(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	got, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got != 0 {
		t.Errorf("RebuildMerchantBalance for a merchant with no batches = %d, want 0", got)
	}
}

// FH: duplicate of the export test? delete one rebuild impl -- claude suggests keeping FromExport as "more authoritative"
func TestRebuildAllBalances_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertBatch(t, pool, merchantID, 2, "closed", 20000)
	insertBatch(t, pool, merchantID, 1, "paid", 500)
	wantBalance := int64(20000)

	// Seed a deliberately WRONG cached value, simulating drift (a crash
	// between CloseBatch and PayoutBatch, or any other cause) —
	// RebuildAllBalances must overwrite it with the closed, unpaid batch
	// net, not merely apply a delta.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 999999, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RebuildAllBalances(context.Background(), pool)
	if err != nil {
		t.Fatalf("RebuildAllBalances: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RebuildAllBalances did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 999999 {
		t.Errorf("diff.CachedBefore = %d, want 999999 (the drifted value)", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != wantBalance {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, wantBalance)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true (cached value was drifted)")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != wantBalance {
		t.Errorf("persisted cached_payable_fils = %d, want %d (RebuildAllBalances must overwrite, not merely diff)", persisted, wantBalance)
	}
}

// BHA-46: `rebuild-balances --merchant` printed the rebuilt figure but never
// wrote it, so a drifted cache stayed drifted.
func TestRebuildMerchantBalance_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertBatch(t, pool, merchantID, 2, "closed", 20000)
	insertBatch(t, pool, merchantID, 1, "paid", 500)
	wantBalance := int64(20000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 999999, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	got, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if int64(got) != wantBalance {
		t.Errorf("RebuildMerchantBalance = %d, want %d", got, wantBalance)
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != wantBalance {
		t.Errorf("persisted cached_payable_fils = %d, want %d (--merchant must write, like the full rebuild)", persisted, wantBalance)
	}
}

// TestRebuildAllBalances_KeepsConcurrentPayout runs a rebuild while a payout
// transaction is open, shaped like PayoutBatch: the batch marked paid, then
// the cache decrement. The rebuild must wait for the payout and leave its
// batch out, not overwrite the decrement with a sum taken before it committed.
func TestRebuildAllBalances_KeepsConcurrentPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	insertBatch(t, pool, merchantID, 2, "closed", 7000)
	paidBatchID := insertBatch(t, pool, merchantID, 1, "closed", 3000)
	if _, err := RebuildMerchantBalance(ctx, pool, merchantID); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	payout, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin payout: %v", err)
	}
	defer payout.Rollback(ctx) //nolint:errcheck
	var payoutPID int
	if err := payout.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&payoutPID); err != nil {
		t.Fatalf("payout pid: %v", err)
	}
	_, err = payout.Exec(ctx, `
		UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1
	`, paidBatchID)
	if err != nil {
		t.Fatalf("payout batch status: %v", err)
	}
	_, err = payout.Exec(ctx, `
		UPDATE merchant_balances SET cached_payable_fils = cached_payable_fils - 3000 WHERE merchant_id = $1
	`, merchantID)
	if err != nil {
		t.Fatalf("payout cache decrement: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := RebuildAllBalances(ctx, pool)
		done <- err
	}()

	// Commit the payout only once the rebuild is waiting on its lock.
	waitUntilBlockedBy(t, pool, payoutPID)
	if err := payout.Commit(ctx); err != nil {
		t.Fatalf("commit payout: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RebuildAllBalances: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("RebuildAllBalances did not finish after the payout committed")
	}

	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 7000 {
		t.Errorf("cached_payable_fils = %d, want 7000 (the batch still unpaid); the rebuild overwrote the payout", cached)
	}
}

// TestRebuildAllBalances_KeepsConcurrentCloseWithoutCacheRow runs a rebuild
// while a batch close is open for a merchant that has a closed batch but no
// merchant_balances row yet, shaped like CloseBatch: the batch written as
// closed, then balances.ApplyBatchClose. There is no row for the rebuild to
// lock, so it must still wait for the close and count it, not insert a sum
// taken before the close committed.
func TestRebuildAllBalances_KeepsConcurrentCloseWithoutCacheRow(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	insertBatch(t, pool, merchantID, 2, "closed", 10000)

	closing, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin close: %v", err)
	}
	defer closing.Rollback(ctx) //nolint:errcheck
	var closePID int
	if err := closing.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&closePID); err != nil {
		t.Fatalf("close pid: %v", err)
	}
	var batchID uuid.UUID
	err = closing.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, current_date - 1, 'closed', 500, 0, 500, now())
		RETURNING id
	`, merchantID).Scan(&batchID)
	if err != nil {
		t.Fatalf("close batch row: %v", err)
	}
	if err := balances.ApplyBatchClose(ctx, closing, merchantID, batchID, 500); err != nil {
		t.Fatalf("close cache upsert: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := RebuildAllBalances(ctx, pool)
		done <- err
	}()

	waitUntilBlockedBy(t, pool, closePID)
	if err := closing.Commit(ctx); err != nil {
		t.Fatalf("commit close: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RebuildAllBalances: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("RebuildAllBalances did not finish after the close committed")
	}

	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 10500 {
		t.Errorf("cached_payable_fils = %d, want 10500 (both closed batches); the rebuild overwrote the close", cached)
	}
}

// TestRebuildMerchantBalance_KeepsConcurrentClose runs a per-merchant rebuild
// while a batch close for the same merchant is open, shaped like CloseBatch:
// the batch row written as closed, then balances.ApplyBatchClose. The rebuild
// must wait for the close and count its batch.
func TestRebuildMerchantBalance_KeepsConcurrentClose(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	insertBatch(t, pool, merchantID, 2, "closed", 10000)
	if _, err := RebuildMerchantBalance(ctx, pool, merchantID); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	closing, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin close: %v", err)
	}
	defer closing.Rollback(ctx) //nolint:errcheck
	var closePID int
	if err := closing.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&closePID); err != nil {
		t.Fatalf("close pid: %v", err)
	}
	var batchID uuid.UUID
	err = closing.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, current_date - 1, 'closed', 500, 0, 500, now())
		RETURNING id
	`, merchantID).Scan(&batchID)
	if err != nil {
		t.Fatalf("close batch row: %v", err)
	}
	if err := balances.ApplyBatchClose(ctx, closing, merchantID, batchID, 500); err != nil {
		t.Fatalf("close cache upsert: %v", err)
	}

	type rebuildResult struct {
		balance int64
		err     error
	}
	done := make(chan rebuildResult, 1)
	go func() {
		balance, err := RebuildMerchantBalance(ctx, pool, merchantID)
		done <- rebuildResult{balance: int64(balance), err: err}
	}()

	waitUntilBlockedBy(t, pool, closePID)
	if err := closing.Commit(ctx); err != nil {
		t.Fatalf("commit close: %v", err)
	}

	select {
	case result := <-done:
		if result.err != nil {
			t.Fatalf("RebuildMerchantBalance: %v", result.err)
		}
		if result.balance != 10500 {
			t.Errorf("RebuildMerchantBalance = %d, want 10500 (both closed batches)", result.balance)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("RebuildMerchantBalance did not finish after the close committed")
	}

	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 10500 {
		t.Errorf("cached_payable_fils = %d, want 10500 (both closed batches); the per-merchant rebuild overwrote the close", cached)
	}
}

// TestRebuildAllBalances_DoesNotDeadlockWithAdjustment runs a rebuild while
// an admin balance adjustment is open, shaped like applyBalanceCorrection in
// apps/api/src/admin/balanceAdjustments.ts: SELECT ... FOR UPDATE on the
// cache row, then an UPDATE of it. A rebuild lock that lets FOR UPDATE
// through would take the row's write lock while the adjustment's UPDATE waits
// on the table lock, and Postgres would abort one of them with 40P01.
func TestRebuildAllBalances_DoesNotDeadlockWithAdjustment(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	insertBatch(t, pool, merchantID, 1, "closed", 10000)
	if _, err := RebuildMerchantBalance(ctx, pool, merchantID); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	adjustment, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin adjustment: %v", err)
	}
	defer adjustment.Rollback(ctx) //nolint:errcheck
	var adjustmentPID int
	if err := adjustment.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&adjustmentPID); err != nil {
		t.Fatalf("adjustment pid: %v", err)
	}
	var before int64
	err = adjustment.QueryRow(ctx, `
		SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1 FOR UPDATE
	`, merchantID).Scan(&before)
	if err != nil {
		t.Fatalf("adjustment row lock: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := RebuildAllBalances(ctx, pool)
		done <- err
	}()

	waitUntilBlockedBy(t, pool, adjustmentPID)
	_, err = adjustment.Exec(ctx, `
		UPDATE merchant_balances
		   SET cached_payable_fils = cached_payable_fils + 250, updated_at = now()
		 WHERE merchant_id = $1
	`, merchantID)
	if err != nil {
		t.Fatalf("adjustment update: %v", err)
	}
	if err := adjustment.Commit(ctx); err != nil {
		t.Fatalf("commit adjustment: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RebuildAllBalances: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("RebuildAllBalances did not finish after the adjustment committed")
	}

	// The adjustment is cache-only (ADR-0006), so the rebuild that ran after
	// it puts the cache back on the closed, unpaid batches.
	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 10000 {
		t.Errorf("cached_payable_fils = %d, want 10000 (the closed, unpaid batch)", cached)
	}
}

// waitUntilBlockedBy returns once some backend is waiting on a lock held by
// pid, so a test can commit pid's transaction while the rebuild waits on it.
func waitUntilBlockedBy(t *testing.T, pool *pgxpool.Pool, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		err := pool.QueryRow(context.Background(), `
			SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
		`, pid).Scan(&waiting)
		if err != nil {
			t.Fatalf("check rebuild is waiting: %v", err)
		}
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing waited on backend %d's locks within 10s", pid)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
