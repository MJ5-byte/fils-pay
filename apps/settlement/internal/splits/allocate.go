// Package splits implements the sub-merchant settlement split: a parent
// merchant whose settlement proceeds are distributed across one or more
// child (sub-)merchant accounts, per merchant_split_children
// (db/migrations/0045).
package splits

import (
	"context"
	"fmt"
	"sort"

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

	var shares []ChildShare
	for rows.Next() {
		var childID uuid.UUID
		var weightBps int64
		if err := rows.Scan(&childID, &weightBps); err != nil {
			rows.Close()
			return SplitPayoutResult{}, err
		}
		shares = append(shares, ChildShare{ChildMerchantID: childID, WeightBps: weightBps})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SplitPayoutResult{}, err
	}
	rows.Close()

	allocateByWeight(shares, money.Fils(netPayout))

	var totalAllocated money.Fils
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
		totalAllocated += s.AllocatedFils
	}

	// Bring the parent's cached balance down by what the legs above actually
	// debited from its merchant_payable account, same as PayoutBatch does
	// for a non-split merchant.
	// Allocation is exact (shares sum to netPayout), so the cache moves by the
	// batch's full net payout.
	if totalAllocated != money.Fils(netPayout) {
		return SplitPayoutResult{}, fmt.Errorf("splits: PayoutSplitBatch: allocated %d fils of %d net payout (child weights must sum to 10000 bps)", totalAllocated, netPayout)
	}
	if err := balances.ApplyPayout(ctx, tx, parentMerchantID, batchID, totalAllocated); err != nil {
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

// allocateByWeight fills in AllocatedFils for every share so that they sum to
// exactly total, using the largest-remainder method (ties broken by position,
// i.e. by child merchant id, so the result is reproducible). Applying each
// weight independently with ApplyRateFils rounds every share on its own and
// leaves the shares a few fils off the parent's payout.
func allocateByWeight(shares []ChildShare, total money.Fils) {
	var sumWeights int64
	for _, s := range shares {
		sumWeights += s.WeightBps
	}
	if len(shares) == 0 || sumWeights <= 0 || total <= 0 {
		return
	}
	type rem struct {
		idx int
		r   int64
	}
	rems := make([]rem, len(shares))
	var allocated int64
	for i := range shares {
		product := int64(total) * shares[i].WeightBps
		base := product / sumWeights
		shares[i].AllocatedFils = money.Fils(base)
		rems[i] = rem{idx: i, r: product % sumWeights}
		allocated += base
	}
	leftover := int64(total) - allocated
	sort.SliceStable(rems, func(a, b int) bool { return rems[a].r > rems[b].r })
	for k := 0; leftover > 0 && k < len(rems); k++ {
		shares[rems[k].idx].AllocatedFils++
		leftover--
	}
}
