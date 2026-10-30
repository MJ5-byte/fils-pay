package ledger

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefreshBalanceCache recomputes each merchant's cached balance and
// overwrites merchant_balances in one transaction. It reads the ledger, exactly
// like the rebuild-balances CLI: an earlier version summed scheme export
// lines instead, which ignores refunds, fee reversals, adjustments and
// residue, so the admin button and the CLI disagreed (FP-203).
func RefreshBalanceCache(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	return RebuildAllBalances(ctx, db)
}
