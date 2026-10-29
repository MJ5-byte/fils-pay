// Package ledger rebuilds merchant_balances from ledger_entries. Nothing
// automatic calls this — the incremental path is in internal/balances.
// This is for the manual `rebuild-balances` CLI subcommand.
package ledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// RebuildMerchantBalance recomputes merchantID's cached balance from
// ledger_entries and overwrites merchant_balances with it, the same write
// RebuildAllBalances makes per merchant. CLI-only; the incremental path is
// in internal/balances.
func RebuildMerchantBalance(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (money.Fils, error) {
	var balance int64
	err := db.QueryRow(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		SELECT $1, COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0), now()
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = EXCLUDED.cached_payable_fils, updated_at = now()
		RETURNING cached_payable_fils
	`, merchantID).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): %w", merchantID, err)
	}
	return money.Fils(balance), nil
}

// RebuildDiff is the before/after state for one merchant, printed by the
// rebuild-balances CLI subcommand so an operator sees exactly what
// changed.
//
// Changed reports drift against the ledger: a false result means the cache
// already matched ledger_entries for that merchant.
type RebuildDiff struct {
	MerchantID   uuid.UUID
	CachedBefore money.Fils
	Rebuilt      money.Fils
}

// Changed reports whether the cached value differed from the rebuilt,
// authoritative one.
func (d RebuildDiff) Changed() bool {
	return d.CachedBefore != d.Rebuilt
}

// RebuildAllBalances recomputes every merchant's balance the same way and
// overwrites merchant_balances in one transaction. Returns the full
// before/after map so a caller (the rebuild-balances CLI subcommand) can
// print exactly what changed. The only function in this codebase that
// writes merchant_balances from a full ledger recompute rather than an
// incremental delta.
func RebuildAllBalances(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT DISTINCT merchant_id FROM (
			SELECT merchant_id FROM ledger_entries WHERE account_id = 'merchant_payable'
			UNION
			SELECT merchant_id FROM merchant_balances
		) merchants
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: select merchant ids: %w", err)
	}

	var merchantIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RebuildAllBalances: scan merchant id: %w", err)
		}
		merchantIDs = append(merchantIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: iterate merchant ids: %w", err)
	}
	rows.Close()

	// TODO: lock merchant_balances rows first, a concurrent CloseBatch increment gets clobbered -- YA
	diffs := make(map[uuid.UUID]RebuildDiff, len(merchantIDs))

	for _, merchantID := range merchantIDs {
		var cachedBefore int64
		err := tx.QueryRow(ctx, `
			SELECT COALESCE(cached_payable_fils, 0) FROM merchant_balances WHERE merchant_id = $1
		`, merchantID).Scan(&cachedBefore)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: read cached balance for %s: %w", merchantID, err)
		}

		var rebuilt int64
		err = tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
			  FROM ledger_entries
			 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
		`, merchantID).Scan(&rebuilt)
		if err != nil {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: recompute balance for %s: %w", merchantID, err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
			VALUES ($1, $2, now())
			ON CONFLICT (merchant_id) DO UPDATE
			  SET cached_payable_fils = $2, updated_at = now()
		`, merchantID, rebuilt)
		if err != nil {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: write rebuilt balance for %s: %w", merchantID, err)
		}

		diffs[merchantID] = RebuildDiff{
			MerchantID:   merchantID,
			CachedBefore: money.Fils(cachedBefore),
			Rebuilt:      money.Fils(rebuilt),
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: commit: %w", err)
	}

	return diffs, nil
}
