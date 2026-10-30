package ledger

import (
	"context"
	"testing"
)

// The admin "Recalculate cached balances" button must read the ledger, like
// the rebuild-balances CLI (FP-203). These tests used to seed scheme export
// lines, the old (wrong) source, so they only passed while the bug existed.

func TestRefreshBalanceCache_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, merchantID, "credit", 25000)
	want := int64(25000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 888888, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 888888 {
		t.Errorf("diff.CachedBefore = %d, want 888888", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != want {
		t.Errorf("persisted cached_payable_fils = %d, want %d", persisted, want)
	}
}

func TestRefreshBalanceCache_SumsAcrossBatches(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, merchantID, "credit", 15000)
	postLedgerLeg(t, pool, merchantID, "credit", 6000)

	want := int64(15000 + 6000)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
}
