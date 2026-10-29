package ledger

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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

func TestRebuildMerchantBalance_MatchesDirectSummation(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	// Credits increase the merchant_payable liability (money owed to the
	// merchant); debits reduce it (fees, payouts).
	postLedgerLeg(t, pool, merchantID, "credit", 10000)
	postLedgerLeg(t, pool, merchantID, "credit", 5000)
	postLedgerLeg(t, pool, merchantID, "debit", 375) // e.g. an MDR fee
	postLedgerLeg(t, pool, merchantID, "debit", 2000)

	want := int64(10000 + 5000 - 375 - 2000)

	got, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if int64(got) != want {
		t.Errorf("RebuildMerchantBalance = %d, want %d", got, want)
	}

	// Cross-check against a raw direct-summation query independent of the
	// function under test.
	var direct int64
	err = pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&direct)
	if err != nil {
		t.Fatalf("direct summation query: %v", err)
	}
	if int64(got) != direct {
		t.Errorf("RebuildMerchantBalance (%d) disagrees with direct summation (%d)", got, direct)
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
		t.Errorf("RebuildMerchantBalance for a merchant with no ledger activity = %d, want 0", got)
	}
}

// FH: duplicate of the export test? delete one rebuild impl -- claude suggests keeping FromExport as "more authoritative"
func TestRebuildAllBalances_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, merchantID, "credit", 20000)
	postLedgerLeg(t, pool, merchantID, "debit", 500)
	wantBalance := int64(20000 - 500)

	// Seed a deliberately WRONG cached value, simulating drift (a crash
	// between CloseBatch and PayoutBatch, or any other cause) —
	// RebuildAllBalances must overwrite it with the true, ledger-derived
	// figure, not merely apply a delta.
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

	postLedgerLeg(t, pool, merchantID, "credit", 20000)
	postLedgerLeg(t, pool, merchantID, "debit", 500)
	wantBalance := int64(20000 - 500)

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
// transaction is open, shaped like PayoutBatch: a merchant_payable debit,
// then the cache decrement. The rebuild must wait for the payout and count
// its debit, not overwrite the decrement with a sum taken before it committed.
func TestRebuildAllBalances_KeepsConcurrentPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 10000)
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
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable', 'debit',  3000, now(), 'test payout'),
		  ($1, $2, 'platform_cash',    'credit', 3000, now(), 'test payout')
	`, uuid.New(), merchantID)
	if err != nil {
		t.Fatalf("payout ledger legs: %v", err)
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
		t.Errorf("cached_payable_fils = %d, want 7000 (the ledger after the payout); the rebuild overwrote the payout", cached)
	}
}

// TestRebuildAllBalances_KeepsConcurrentCreditWithoutCacheRow runs a rebuild
// while a manual credit is open for a merchant that has ledger activity but
// no merchant_balances row yet, shaped like the admin credit in
// apps/api/src/admin/credits.ts: ledger legs, then an upsert of the cache.
// There is no row for the rebuild to lock, so it must still wait for the
// credit and count it, not insert a sum taken before the credit committed.
func TestRebuildAllBalances_KeepsConcurrentCreditWithoutCacheRow(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 10000)

	credit, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin credit: %v", err)
	}
	defer credit.Rollback(ctx) //nolint:errcheck
	var creditPID int
	if err := credit.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&creditPID); err != nil {
		t.Fatalf("credit pid: %v", err)
	}
	_, err = credit.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable',       'credit', 500, now(), 'test manual credit'),
		  ($1, $2, 'merchant_credit_contra', 'debit',  500, now(), 'test manual credit')
	`, uuid.New(), merchantID)
	if err != nil {
		t.Fatalf("credit ledger legs: %v", err)
	}
	_, err = credit.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 500, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils,
		      updated_at = now()
	`, merchantID)
	if err != nil {
		t.Fatalf("credit cache upsert: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := RebuildAllBalances(ctx, pool)
		done <- err
	}()

	waitUntilBlockedBy(t, pool, creditPID)
	if err := credit.Commit(ctx); err != nil {
		t.Fatalf("commit credit: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RebuildAllBalances: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("RebuildAllBalances did not finish after the credit committed")
	}

	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 10500 {
		t.Errorf("cached_payable_fils = %d, want 10500 (the ledger after the credit); the rebuild overwrote the credit", cached)
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
	postLedgerLeg(t, pool, merchantID, "credit", 10000)
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
	// it puts the cache back on the ledger.
	var cached int64
	err = pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 10000 {
		t.Errorf("cached_payable_fils = %d, want 10000 (the ledger sum)", cached)
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
