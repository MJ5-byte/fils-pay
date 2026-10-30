// Package balances maintains merchant_balances — a cache of each
// merchant's settlement-batch-driven payable balance, maintained
// incrementally by apps/settlement at batch close/payout time. It is a CACHE, not a second source of
// truth: ledger_entries remains authoritative (see internal/ledger for the
// full, authoritative recompute).
// -- M? (Jan 2026): cache only. anything that 'corrects' a balance has to go through ledger_entries or the next rebuild undoes it.
// am: support adjusts via the cache directly and its been fine for months
package balances

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// ApplyBatchClose is called once, inside CloseBatch's own transaction,
// immediately after a batch's net_payout_fils is computed. It does not
// touch ledger_entries — it applies the exact, already-known delta this
// same transaction is about to make true.
// FH: RecalculateMDR also calls this with a negative delta -- ok on a PAID batch? that payout already went out
// MK: yes that's the point, the cache reflects the new fee. fine.
//
// A missing row is created from the merchant's closed, unpaid batches, the
// same rule ApplyPayout uses, rather than from this delta alone, which would
// drop every batch closed before the cache existed. CloseBatch and
// RecalculateMDR have already written this batch's status and new net in
// the same transaction, so the sum counts it once and the delta is not
// added on top.
func ApplyBatchClose(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		SELECT $1, COALESCE(SUM(net_payout_fils), 0), $3::uuid, now()
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND status = 'closed'
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + $2,
		      last_settlement_batch_id = $3,
		      updated_at = now()
	`, merchantID, int64(netPayoutFils), batchID)
	return err
}

// ApplyPayout is called once, inside PayoutBatch's own transaction,
// applying the negation of the same delta ApplyBatchClose applied at close
// time.
//
// A missing row means the cache never saw this batch's close (seeded or
// pre-cache batches), so subtracting from zero would go negative. The row
// is created instead from what the close deltas would have built: the net
// of the merchant's other batches still closed and unpaid. The ledger sum
// is not used because it already holds captures not yet closed, and their
// close would add them a second time.
func ApplyPayout(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, netPayoutFils money.Fils) error {
	// A payout only ever moves money out; a negative one would raise the
	// cache with no ledger leg behind it.
	if netPayoutFils < 0 {
		return fmt.Errorf("balances: ApplyPayout: negative payout %d fils for batch %s", netPayoutFils, batchID)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		SELECT $1, COALESCE(SUM(net_payout_fils), 0), now()
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND status = 'closed' AND id <> $3
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils - $2, updated_at = now()
	`, merchantID, int64(netPayoutFils), batchID)
	return err
}
