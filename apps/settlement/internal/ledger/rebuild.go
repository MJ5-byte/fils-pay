// Package ledger rebuilds merchant_balances from the merchant's closed,
// unpaid settlement batches (ADR-0007, amended for BHA-189). Nothing
// automatic calls this — the incremental path is in internal/balances.
// The `rebuild-balances` CLI subcommand and the admin console's rebuild
// button (internalapi) both call it, so they always write the same figure.
package ledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// closedUnpaidNetSQL is what merchant_balances holds: the net of the
// merchant's batches that are closed and not yet paid out. It is the rule
// balances.ApplyBatchClose and ApplyPayout already use for a missing row.
// The ledger's merchant_payable cannot be the source, because it counts a
// capture or a manual credit the moment it posts, and the next CloseBatch
// adds the same money again through ApplyBatchClose.
const closedUnpaidNetSQL = `
	SELECT COALESCE(SUM(net_payout_fils), 0)
	  FROM settlement_batches
	 WHERE merchant_id = $1 AND status = 'closed'
`

// RebuildMerchantBalance recomputes merchantID's cached balance from its
// closed, unpaid batches and overwrites merchant_balances with it, the same write
// RebuildAllBalances makes per merchant. It takes the same table lock as
// RebuildAllBalances. CLI-only; the incremental path is in internal/balances.
func RebuildMerchantBalance(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (money.Fils, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): begin: %w", merchantID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): set lock timeout: %w", merchantID, err)
	}
	// Take the same lock as RebuildAllBalances (see its comment) so a close
	// or payout that wrote the cache but has not committed finishes before
	// the sum is read, instead of being overwritten by a sum taken before
	// it committed.
	if _, err := tx.Exec(ctx, `LOCK TABLE merchant_balances IN EXCLUSIVE MODE`); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): merchant_balances is busy, lock not granted within 5s, nothing changed; try again: %w", merchantID, err)
		}
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): lock balances: %w", merchantID, err)
	}

	var balance int64
	err = tx.QueryRow(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		SELECT $1, (`+closedUnpaidNetSQL+`), now()
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = EXCLUDED.cached_payable_fils, updated_at = now()
		RETURNING cached_payable_fils
	`, merchantID).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): %w", merchantID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): commit: %w", merchantID, err)
	}
	return money.Fils(balance), nil
}

// RebuildDiff is the before/after state for one merchant, printed by the
// rebuild-balances CLI subcommand so an operator sees exactly what
// changed.
//
// Changed reports drift: a false result means the cache already matched the
// merchant's closed, unpaid batches.
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
// before/after map so a caller (the rebuild-balances CLI subcommand, the
// admin rebuild button) can show exactly what changed. The only function in
// this codebase that writes merchant_balances from a full recompute rather
// than an incremental delta.
func RebuildAllBalances(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock the cache table before reading the batches. EXCLUSIVE blocks every
	// insert and update of merchant_balances, including the first one for a
	// merchant with no row yet, and every SELECT ... FOR UPDATE (the admin
	// balance adjustment locks its row that way before it updates); plain
	// SELECTs still pass. A writer that got in first (a close, a payout, an
	// adjustment) commits before the sum is read, so its batch status is
	// counted; a later one waits and applies its delta on top of the rebuilt
	// value. Without the lock a delta
	// committed between the sum and the write was overwritten. This is the
	// first lock the transaction takes and nothing a writer holds lets it
	// through early, so it cannot deadlock with a writer, and two rebuilds
	// run one after the other.
	//
	// While the rebuild waits for the lock, every later writer queues behind
	// it, so it gives up after 5 s rather than stall payouts and credits.
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: set lock timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE merchant_balances IN EXCLUSIVE MODE`); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: merchant_balances is busy, lock not granted within 5s, nothing changed; try again: %w", err)
		}
		return nil, fmt.Errorf("ledger: RebuildAllBalances: lock balances: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT DISTINCT merchant_id FROM (
			SELECT merchant_id FROM settlement_batches WHERE status = 'closed'
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
		err = tx.QueryRow(ctx, closedUnpaidNetSQL, merchantID).Scan(&rebuilt)
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
