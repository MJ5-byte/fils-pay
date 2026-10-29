package ledger

import (
	"context"
	"os"
	"testing"

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
