// Package splits implements the sub-merchant settlement split: a parent
// merchant whose settlement proceeds are distributed across one or more
// child (sub-)merchant accounts, per merchant_split_children
// (db/migrations/0045).
package splits

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
)

// ChildShare is one child's computed allocation from a parent's settlement
// batch payout.
//
// AllocatedFils is never negative; a zero share is skipped when posting.
type ChildShare struct {
	ChildMerchantID uuid.UUID
	WeightBps       int64
	AllocatedFils   money.Fils
}

// SplitPayoutResult is PayoutSplitBatch's return value — mirrors
// PayoutBatch's own result shape (settlement.PayoutResult) so the two are
// interchangeable from RunDailyBatch's point of view.
//
// Shares always sum to the batch's net_payout_fils, so a caller can
// reconcile a split payout against the batch without re-reading the legs.
type SplitPayoutResult struct {
	BatchID          uuid.UUID
	ParentMerchantID uuid.UUID
	AlreadyPaid      bool
	NotClosed        bool
	Shares           []ChildShare
}

// IsSplitParent reports whether merchantID has any configured sub-merchant
// split children.
// YA (Apr 2026, last week here): split is behind a flag, no merchant has children in prod
func IsSplitParent(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (bool, error) {
	var exists bool
	err := db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM merchant_split_children WHERE parent_merchant_id = $1)
	`, merchantID).Scan(&exists)
	return exists, err
}

// PayoutSplitBatch posts a settlement batch's net payout as a weighted
// split across the parent's configured sub-merchants.
func PayoutSplitBatch(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID) (SplitPayoutResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return SplitPayoutResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var parentMerchantID uuid.UUID
	var status string
	var netPayout int64
	err = tx.QueryRow(ctx, `
		SELECT merchant_id, status, net_payout_fils FROM settlement_batches WHERE id = $1 FOR UPDATE
	`, batchID).Scan(&parentMerchantID, &status, &netPayout)
	if err != nil {
		return SplitPayoutResult{}, err
	}

	if status == "paid" {
		tx.Rollback(ctx) //nolint:errcheck
		return SplitPayoutResult{BatchID: batchID, ParentMerchantID: parentMerchantID, AlreadyPaid: true}, nil
	}
	if status != "closed" {
		tx.Rollback(ctx) //nolint:errcheck
		return SplitPayoutResult{BatchID: batchID, ParentMerchantID: parentMerchantID, NotClosed: true}, nil
	}

	rows, err := tx.Query(ctx, `
		SELECT child_merchant_id, split_weight_bps
		  FROM merchant_split_children
		 WHERE parent_merchant_id = $1
		 ORDER BY child_merchant_id
	`, parentMerchantID)
	if err != nil {
		return SplitPayoutResult{}, err
	}

	var childIDs []uuid.UUID
	var weights []int64
	for rows.Next() {
		var childID uuid.UUID
		var weightBps int64
		if err := rows.Scan(&childID, &weightBps); err != nil {
			rows.Close()
			return SplitPayoutResult{}, err
		}
		childIDs = append(childIDs, childID)
		weights = append(weights, weightBps)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SplitPayoutResult{}, err
	}
	rows.Close()

	// Largest-remainder allocation (same contract as ChildShares): each
	// child's share is netPayout*weightBps/10000 floored, and the leftover
	// fils go to the largest fractional remainders (ties by ascending
	// child index), so the posted legs always sum back to the batch's
	// net_payout_fils — no fils silently lost to per-child independent
	// rounding.
	allocatedShares := AllocateRemainder(money.Fils(netPayout), weights)
	shares := make([]ChildShare, len(childIDs))
	for i, childID := range childIDs {
		shares[i] = ChildShare{ChildMerchantID: childID, WeightBps: weights[i], AllocatedFils: allocatedShares[i]}
	}

	for _, s := range shares {
		if s.AllocatedFils <= 0 {
			continue // ledger_entries.amount_fils has a CHECK (amount_fils > 0)
		}
		groupID := uuid.New()
		_, err = tx.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable', 'debit',  $4, now(), 'settlement payout: split to sub-merchant'),
			  ($1, $2, $3, 'platform_cash',    'credit', $4, now(), 'settlement payout: split to sub-merchant')
		`, groupID, parentMerchantID, batchID, int64(s.AllocatedFils))
		if err != nil {
			return SplitPayoutResult{}, err
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO settlement_batch_splits (settlement_batch_id, child_merchant_id, split_weight_bps, allocated_fils)
			VALUES ($1, $2, $3, $4)
		`, batchID, s.ChildMerchantID, s.WeightBps, int64(s.AllocatedFils))
		if err != nil {
			return SplitPayoutResult{}, err
		}
	}

	// Bring the parent's cached balance down by the batch's net payout,
	// same as PayoutBatch does for a non-split merchant. The shares above
	// sum to netPayout, so this is exactly what the legs debited — passing
	// the batch figure (rather than a recomputed sum of the shares) keeps
	// the cache from drifting from the batch even if a later change ever
	// reintroduced a rounding difference.
	if err := balances.ApplyPayout(ctx, tx, parentMerchantID, batchID, money.Fils(netPayout)); err != nil {
		return SplitPayoutResult{}, err
	}

	// Same lifetime monitoring bump PayoutBatch applies to a non-split
	// merchant. Inlined here rather than calling settlement's
	// UpdateLifetimePayoutMonitoringEstimate (which would import
	// internal/settlement from a package it already imports) — the SQL
	// mirrors it exactly.
	if _, err := tx.Exec(ctx, `
		UPDATE merchants
		   SET lifetime_net_payout_monitoring_estimate = lifetime_net_payout_monitoring_estimate + $2
		 WHERE id = $1
	`, parentMerchantID, netPayout); err != nil {
		return SplitPayoutResult{}, err
	}

	_, err = tx.Exec(ctx, `UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, batchID)
	if err != nil {
		return SplitPayoutResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return SplitPayoutResult{}, err
	}
	return SplitPayoutResult{BatchID: batchID, ParentMerchantID: parentMerchantID, Shares: shares}, nil
}
