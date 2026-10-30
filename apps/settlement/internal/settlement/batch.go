package settlement

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
	"github.com/filspay/settlement/internal/splits"
)

// ErrMerchantNotEligible is returned by CloseBatch when the merchant is
// not active/non-test-mode at the time of the call — CloseBatch is not
// meant to be invoked directly for such a merchant; the batching pass
// (RunDailyBatch) already filters merchants before ever calling it.
var ErrMerchantNotEligible = errors.New("settlement: merchant not found or not eligible for settlement")

// ErrBusinessDayNotOver is returned by CloseBatch for a business day that has
// not yet ended in Asia/Bahrain time. Closing it early would mark the batch
// closed before the rest of that day's captures land, and those later
// captures fall outside every other day's window, so they would never settle.
var ErrBusinessDayNotOver = errors.New("settlement: business day has not ended yet in Asia/Bahrain time")

// now is the clock CloseBatch checks the business day against; tests replace it.
var now = time.Now

// BatchResult is CloseBatch's return value.
type BatchResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	BatchDate     time.Time
	AlreadyClosed bool // true when this call found an existing 'closed'/'paid' batch and made no changes (idempotent no-op)
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
	EventCount    int
	LineCount     int
}

// PayoutResult is PayoutBatch's return value.
type PayoutResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	AlreadyPaid   bool // true when the batch was already 'paid' (idempotent no-op)
	NotClosed     bool // true when the batch is not 'closed' (e.g. still 'open') — also a no-op
	NetPayoutFils money.Fils
}

type eligibleEvent struct {
	id            int64
	transactionID uuid.UUID
	amountFils    money.Fils
	occurredAt    time.Time
	// journaledFeeFils is the MDR fee capture.ts posted for this event
	// (metadata.feeFils), or nil when the event carries none or carries
	// something other than a whole, non-negative number of fils.
	journaledFeeFils *int64
}

// CloseBatch computes and freezes settlement figures for one merchant's
// one business day. Idempotent: re-running it against an already-closed
// or already-paid batch for the same (merchant, date) is a safe no-op.
// Every capture-type transaction_events row, every manual-credit
// merchant_payable ledger leg and every refunds row it selects is marked
// with this batch's id inside the same transaction that freezes the batch's
// totals, so a row can never be picked up by two batches.
func CloseBatch(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) (BatchResult, error) {
	start, end := BusinessDayWindow(businessDate)
	if now().Before(end) {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch(%s): %w", businessDate.Format("2006-01-02"), ErrBusinessDayNotOver)
	}
	batchDateOnly := time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day(), 0, 0, 0, 0, time.UTC)

	tx, err := db.Begin(ctx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Step 2: create the batch row if it doesn't already exist.
	_, err = tx.Exec(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status)
		VALUES ($1, $2, 'open')
		ON CONFLICT (merchant_id, batch_date) DO NOTHING
	`, merchantID, batchDateOnly)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert batch: %w", err)
	}

	// Step 3: row-lock the batch. This is what actually serializes
	// concurrent CloseBatch calls for the same (merchant, date).
	var batchID uuid.UUID
	var status string
	err = tx.QueryRow(ctx, `
		SELECT id, status FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date = $2
		 FOR UPDATE
	`, merchantID, batchDateOnly).Scan(&batchID, &status)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: lock batch: %w", err)
	}

	// Step 4: already closed/paid -> idempotent no-op, nothing to undo.
	if status != "open" {
		tx.Rollback(ctx) //nolint:errcheck
		var gross, fee, net int64
		err = db.QueryRow(ctx, `
			SELECT gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1
		`, batchID).Scan(&gross, &fee, &net)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read already-closed batch: %w", err)
		}
		return BatchResult{
			BatchID:       batchID,
			MerchantID:    merchantID,
			BatchDate:     batchDateOnly,
			AlreadyClosed: true,
			GrossFils:     money.Fils(gross),
			FeeFils:       money.Fils(fee),
			NetPayoutFils: money.Fils(net),
		}, nil
	}

	// Step 5: merchant must be active and not in test mode.
	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `
		SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1 AND status = 'active' AND test_mode = false
	`, merchantID).Scan(&mdrBps, &discountBps)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BatchResult{}, ErrMerchantNotEligible
		}
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read merchant: %w", err)
	}

	// Effective-dated fee resolution (apps/settlement/internal/settlement/fee_schedule.go) —
	// loaded once per batch; EffectiveMdrBpsAt is applied per event below so
	// a batch that happens to span a schedule's cutover still charges each
	// event the rate that was actually in effect when it happened, matching
	// apps/api/src/payments/capture.ts's own per-event resolution exactly.
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: load fee schedules: %w", err)
	}

	// Platform-wide volume-tier bonus — read and locked once per batch.
	platformProcessedFils, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read platform volume: %w", err)
	}
	tierBonusBps := VolumeTierMdrBonusBps(platformProcessedFils)

	// Step 6: select and lock eligible events for the whole window. The
	// join is transaction_events (many) -> transactions (one) — the safe
	// direction. Every amount is read from te.amount_fils — the exact
	// incremental delta capture.ts already recorded for that one real
	// event — never from transactions.captured_fils (a running total).
	rows, err := tx.Query(ctx, `
		SELECT te.id, te.transaction_id, te.amount_fils, te.occurred_at,
		       CASE WHEN jsonb_typeof(te.metadata->'feeFils') = 'number'
		             AND te.metadata->>'feeFils' ~ '^[0-9]+$'
		            THEN (te.metadata->>'feeFils')::bigint END
		  FROM transaction_events te
		  JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1
		   AND te.event_type IN ('captured', 'partially_captured')
		   AND te.settlement_batch_id IS NULL
		   AND te.occurred_at >= $2 AND te.occurred_at < $3
		 ORDER BY te.transaction_id, te.occurred_at
		 FOR UPDATE OF te
	`, merchantID, start, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select eligible events: %w", err)
	}

	var events []eligibleEvent
	var orderedTxnIDs []uuid.UUID
	seenTxn := make(map[uuid.UUID]bool)
	for rows.Next() {
		var e eligibleEvent
		var amountFils int64
		if err := rows.Scan(&e.id, &e.transactionID, &amountFils, &e.occurredAt, &e.journaledFeeFils); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan eligible event: %w", err)
		}
		e.amountFils = money.Fils(amountFils)
		events = append(events, e)
		if !seenTxn[e.transactionID] {
			seenTxn[e.transactionID] = true
			orderedTxnIDs = append(orderedTxnIDs, e.transactionID)
		}
	}
	if err := rows.Err(); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate eligible events: %w", err)
	}
	rows.Close()

	// Step 7: group the locked rows in Go, by transaction_id. Zero rows is
	// valid and proceeds with all totals at zero.
	grouped := make(map[uuid.UUID][]eligibleEvent, len(orderedTxnIDs))
	for _, e := range events {
		grouped[e.transactionID] = append(grouped[e.transactionID], e)
	}

	// The negotiated-discount rebates discountAdjustment.ts actually credited
	// back on this batch's captures, summed per transaction. Reading the
	// posted amounts, rather than recomputing them from today's discount
	// rate, keeps the batch equal to the ledger when a rebate never landed
	// (a failed adjustment call, a payment-link capture, a seeded capture
	// whose feeFils is already net of the discount) or the rate changed
	// since. A rebate posts after its capture, so this business day's
	// rebates fall inside its window and other days' stay out.
	rebateFils := make(map[uuid.UUID]money.Fils, len(orderedTxnIDs))
	if len(orderedTxnIDs) > 0 {
		rebateRows, err := tx.Query(ctx, `
			SELECT transaction_id, SUM(amount_fils) FROM ledger_entries
			 WHERE merchant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
			   AND transaction_id = ANY($4::uuid[])
			   AND account_id = 'merchant_payable' AND direction = 'credit'
			   AND description = 'capture: negotiated discount adjustment'
			 GROUP BY transaction_id
		`, merchantID, start, end, orderedTxnIDs)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select discount rebates: %w", err)
		}
		for rebateRows.Next() {
			var txnID uuid.UUID
			var sum int64
			if err := rebateRows.Scan(&txnID, &sum); err != nil {
				rebateRows.Close()
				return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan discount rebate: %w", err)
			}
			rebateFils[txnID] = money.Fils(sum)
		}
		if err := rebateRows.Err(); err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate discount rebates: %w", err)
		}
		rebateRows.Close()
	}

	// Step 8: for each transaction group, and for the batch as a whole.
	// Fee is recomputed PER EVENT, then summed — never ApplyRateFils
	// applied once to the pre-summed total.
	type txnLine struct {
		transactionID uuid.UUID
		grossFils     money.Fils
		feeFils       money.Fils
	}
	var lines []txnLine
	var batchGross, batchFee money.Fils
	var eventIDs []int64

	for _, txnID := range orderedTxnIDs {
		var grossForTxn, feeForTxn money.Fils
		for _, e := range grouped[txnID] {
			grossForTxn += e.amountFils
			eventIDs = append(eventIDs, e.id)
			// The ledger already holds this event's fee: the MDR fee
			// capture.ts posted. Charging that, less the rebates credited
			// back below, keeps the payout equal to merchant_payable even
			// when the volume tier changed between capture and close;
			// re-deriving it is only for events that carry no journaled fee.
			if e.journaledFeeFils != nil {
				feeForTxn += money.Fils(*e.journaledFeeFils)
				continue
			}
			effectiveMdrBps := EffectiveMdrBpsAt(schedules, e.occurredAt, mdrBps)
			if effectiveMdrBps -= tierBonusBps; effectiveMdrBps < 0 {
				effectiveMdrBps = 0
			}
			feeForTxn += ComputeSettlementFee(e.amountFils, effectiveMdrBps, discountBps)
		}
		feeForTxn -= rebateFils[txnID]
		lines = append(lines, txnLine{txnID, grossForTxn, feeForTxn})
		batchGross += grossForTxn
		batchFee += feeForTxn
	}
	capturedGross := batchGross

	// Step 9: claim the merchant's posted manual credits and positive manual
	// adjustments from admin balance adjustments and the CSV import (ADR-0008).
	// admin/credits.ts journals each one straight onto merchant_payable, and
	// a batch payout is the only thing that ever pays merchant_payable out,
	// so the credit rides in the first batch that closes after it posted. It
	// joins gross with no fee, keeping net = gross - fee. Its merchant_payable
	// legs are stamped with this batch's id, the same claim
	// transaction_events gets in step 11, so no later batch pays it again.
	// There is no lower bound: a credit posted before this code shipped, or
	// committed after its own day closed, is picked up by the next close.
	rows, err = tx.Query(ctx, `
		SELECT le.id, le.amount_fils
		  FROM ledger_entries le
		 WHERE le.entry_group_id IN (
		         SELECT cr.ledger_entry_group_id
		           FROM credit_requests cr
		          WHERE cr.merchant_id = $1
		            AND cr.status = 'posted'
		            AND cr.posted_at < $2
		         UNION
		         SELECT adj.entry_group_id
		           FROM ledger_entries adj
		          WHERE adj.merchant_id = $1
		            AND adj.account_id = 'manual_balance_adjustment_contra'
		       )
		   AND le.merchant_id = $1
		   AND le.account_id = 'merchant_payable'
		   AND le.direction = 'credit'
		   AND le.settlement_batch_id IS NULL
		   AND le.occurred_at < $2
		 ORDER BY le.id
		 FOR UPDATE
	`, merchantID, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select unpaid credits: %w", err)
	}
	var creditLegIDs []int64
	var creditFils money.Fils
	for rows.Next() {
		var id, amountFils int64
		if err := rows.Scan(&id, &amountFils); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan unpaid credit: %w", err)
		}
		creditLegIDs = append(creditLegIDs, id)
		creditFils += money.Fils(amountFils)
	}
	if err := rows.Err(); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate unpaid credits: %w", err)
	}
	rows.Close()
	batchGross += creditFils

	// Step 9b: claim unbatched refunds and take them out of the batch: the
	// refunded amount out of gross, the fee processRefund reversed out of
	// fee, so net = gross - fee still holds. A refund is a new money
	// movement on the day it happens, so a refund on a sale whose batch is
	// already paid comes off a later batch instead of reopening the paid one.
	// The window has no lower bound: a refund that did not fit an earlier
	// batch, or whose transaction committed after its own day closed, is
	// picked up by the next close. Refunds are taken oldest first, and one
	// that would push net below zero stays unclaimed and carries forward,
	// because a negative batch has no payout leg to recover the money.
	// Credits are claimed first so they count toward what a refund can
	// come off.
	rows, err = tx.Query(ctx, `
		SELECT id, amount_fils, fee_reversed_fils
		  FROM refunds
		 WHERE merchant_id = $1
		   AND status = 'succeeded'
		   AND settlement_batch_id IS NULL
		   AND occurred_at < $2
		 ORDER BY occurred_at, id
		 FOR UPDATE
	`, merchantID, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select eligible refunds: %w", err)
	}
	var refundIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		var amountFils, feeReversedFils int64
		if err := rows.Scan(&id, &amountFils, &feeReversedFils); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan eligible refund: %w", err)
		}
		if NetPayableFils(batchGross-money.Fils(amountFils), batchFee-money.Fils(feeReversedFils)) < 0 {
			continue
		}
		refundIDs = append(refundIDs, id)
		batchGross -= money.Fils(amountFils)
		batchFee -= money.Fils(feeReversedFils)
	}
	if err := rows.Err(); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate eligible refunds: %w", err)
	}
	rows.Close()

	// Step 9c: a debit adjustment comes off the batch like a refund, after
	// refunds. Take the oldest first; one that would push net below zero
	// stays unclaimed and carries forward because a negative batch has no
	// payout leg to recover the money. There is no lower date bound.
	rows, err = tx.Query(ctx, `
		SELECT le.id, le.amount_fils
		  FROM ledger_entries le
		 WHERE le.merchant_id = $1
		   AND le.account_id = 'merchant_payable'
		   AND le.direction = 'debit'
		   AND le.settlement_batch_id IS NULL
		   AND le.occurred_at < $2
		   AND le.entry_group_id IN (
		         SELECT adj.entry_group_id
		           FROM ledger_entries adj
		          WHERE adj.merchant_id = $1
		            AND adj.account_id = 'manual_balance_adjustment_contra'
		       )
		 ORDER BY le.occurred_at, le.id
		 FOR UPDATE
	`, merchantID, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select debit adjustments: %w", err)
	}
	var adjustmentDebitLegIDs []int64
	for rows.Next() {
		var id, amountFils int64
		if err := rows.Scan(&id, &amountFils); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan debit adjustment: %w", err)
		}
		if NetPayableFils(batchGross-money.Fils(amountFils), batchFee) < 0 {
			continue
		}
		adjustmentDebitLegIDs = append(adjustmentDebitLegIDs, id)
		batchGross -= money.Fils(amountFils)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate debit adjustments: %w", err)
	}
	rows.Close()

	netPayout := NetPayableFils(batchGross, batchFee)

	// Record this batch's contribution to the platform-wide lifetime
	// processed-volume counter, in the same transaction that freezes this
	// batch's own totals — so the counter and the batch it describes
	// commit or roll back together. Processed volume is what was captured:
	// credits are not card volume, and a later refund does not un-process it.
	if err := RecordPlatformProcessedVolume(ctx, tx, platformProcessedFils, int64(capturedGross)); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: record platform volume: %w", err)
	}

	// Step 10: freeze the batch totals.
	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches
		   SET status = 'closed', gross_fils = $2, fee_fils = $3, net_payout_fils = $4, closed_at = now()
		 WHERE id = $1
	`, batchID, int64(batchGross), int64(batchFee), int64(netPayout))
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: freeze batch totals: %w", err)
	}

	// Step 11: mark every included event, credit, adjustment and refund as batched,
	// permanently ineligible for any future batch.
	if len(eventIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE transaction_events SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, eventIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark events batched: %w", err)
		}
	}
	if len(creditLegIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE ledger_entries SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, creditLegIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark credits batched: %w", err)
		}
	}
	if len(adjustmentDebitLegIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE ledger_entries SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, adjustmentDebitLegIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark debit adjustments batched: %w", err)
		}
	}
	if len(refundIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE refunds SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, refundIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark refunds batched: %w", err)
		}
	}

	for i, line := range lines {
		truncated := TruncateToSchemeAmount(line.grossFils)
		// amount_fils (BIGINT) is the durable record; the scheme file BD
		// value is formatted from it at export (LoadSchemeExportLines). The
		// nullable numeric(10,2) amount column is left unset: it overflows on
		// a large capture and carries no value the export reads.
		_, err = tx.Exec(ctx, `
			INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
			VALUES ($1, $2, $3, $4)
		`, batchID, line.transactionID, int64(truncated), i+1)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert scheme export line: %w", err)
		}

		// ADR-0002: the 0-9 fils the scheme never receives move out of
		// card_scheme_clearing into the suspense account, so clearing ties
		// to the scheme file. ledger_entries rejects a zero leg.
		if residue := line.grossFils - truncated; residue > 0 {
			_, err = tx.Exec(ctx, `
				INSERT INTO ledger_entries
				  (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
				VALUES
				  ($1, $2, $3, $4, 'card_scheme_clearing',    'credit', $5, now(), 'scheme rounding residue'),
				  ($1, $2, $3, $4, 'scheme_rounding_residue', 'debit',  $5, now(), 'scheme rounding residue')
			`, uuid.New(), merchantID, line.transactionID, batchID, int64(residue))
			if err != nil {
				return BatchResult{}, fmt.Errorf("settlement: CloseBatch: post scheme rounding residue: %w", err)
			}
		}
	}

	// Step 13: enqueue settlement.batch_closed onto the shared outbox, in
	// the same transaction as the frozen totals.
	payload, err := buildBatchClosedPayload(merchantID, batchID, batchDateOnly, batchGross, batchFee, netPayout)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: build outbox payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
		VALUES ('settlement.batch_closed', 'settlement_batch', $1, $2)
	`, batchID, payload)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: enqueue outbox event: %w", err)
	}

	// Step 14: incrementally update the merchant_balances cache, which holds
	// closed, unpaid batch nets (ADR-0007). Nothing in this batch, credits
	// included, touched the cache before the close, so the whole net is new.
	if err := balances.ApplyBatchClose(ctx, tx, merchantID, batchID, netPayout); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: apply balance cache delta: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: commit: %w", err)
	}

	return BatchResult{
		BatchID:       batchID,
		MerchantID:    merchantID,
		BatchDate:     batchDateOnly,
		AlreadyClosed: false,
		GrossFils:     batchGross,
		FeeFils:       batchFee,
		NetPayoutFils: netPayout,
		EventCount:    len(eventIDs),
		LineCount:     len(lines),
	}, nil
}

// PayoutBatch posts the ledger legs representing an actual payout for an
// already-closed batch and transitions it 'closed' -> 'paid'. Idempotent:
// a batch that is not 'closed' (already 'paid', or somehow still 'open')
// is a safe no-op.
func PayoutBatch(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID) (PayoutResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var merchantID uuid.UUID
	var status string
	var netPayout int64
	err = tx.QueryRow(ctx, `
		SELECT merchant_id, status, net_payout_fils FROM settlement_batches WHERE id = $1 FOR UPDATE
	`, batchID).Scan(&merchantID, &status, &netPayout)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: batch %s not found", batchID)
		}
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: lock batch: %w", err)
	}

	if status == "paid" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, AlreadyPaid: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}
	if status != "closed" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, NotClosed: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}
	// A negative net is money the merchant owes, and a payout has no leg
	// to collect it: marking the batch paid would write it off. CloseBatch
	// never produces one; refuse rather than lose it if something else does.
	if netPayout < 0 {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: batch %s has negative net payout %d fils", batchID, netPayout)
	}

	// Post the payout leg pair only when net_payout_fils > 0 — omitted
	// entirely for an empty or fee-only batch (ledger_entries has a CHECK
	// (amount_fils > 0)). card_scheme_clearing isn't touched here; scheme
	// clearing is its own process.
	if netPayout > 0 {
		groupID := uuid.New()
		_, err = tx.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable', 'debit',  $4, now(), 'settlement payout: batch paid'),
			  ($1, $2, $3, 'platform_cash',    'credit', $4, now(), 'settlement payout: batch paid')
		`, groupID, merchantID, batchID, netPayout)
		if err != nil {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: post payout legs: %w", err)
		}
	}

	// Runs unconditionally, including for a zero-payout batch: adding zero
	// is a no-op, and keeping the running total's every update in lockstep
	// with every processed batch — rather than skipping zero-value ones —
	// keeps its own bookkeeping simple.
	if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, money.Fils(netPayout)); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update lifetime payout monitoring estimate: %w", err)
	}

	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1
	`, batchID)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update batch status: %w", err)
	}

	if err := balances.ApplyPayout(ctx, tx, merchantID, batchID, money.Fils(netPayout)); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: apply balance cache delta: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: commit: %w", err)
	}

	return PayoutResult{BatchID: batchID, MerchantID: merchantID, NetPayoutFils: money.Fils(netPayout)}, nil
}

// DailyBatchReport summarizes one RunDailyBatch pass.
type DailyBatchReport struct {
	BusinessDate    time.Time
	MerchantResults []MerchantBatchOutcome
}

// MerchantBatchOutcome is one merchant's CloseBatch+PayoutBatch outcome
// within a daily pass.
type MerchantBatchOutcome struct {
	MerchantID    uuid.UUID
	BatchID       uuid.UUID
	AlreadyClosed bool
	AlreadyPaid   bool
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
}

// RunDailyBatch closes and pays out every eligible merchant's batch for
// one business date. Called by `run-batch` directly, and by `daemon` once
// per scheduled wake-up for every business day it has not yet settled.
//
// One merchant's failure does not stop the merchants after it: each
// merchant's close and payout are their own transactions, so the run moves
// on and returns every failure joined into one error alongside the report
// of the merchants that did settle.
//
// Sequential processing (one merchant at a time, never concurrently) is a
// deliberate simplicity choice: each merchant's batch is its own pair of
// short transactions, so there is no cross-merchant lock contention to
// parallelize away, and this removes any question of lock-ordering
// between concurrent goroutines each trying to FOR UPDATE a
// settlement_batches row.
func RunDailyBatch(ctx context.Context, db *pgxpool.Pool, businessDate time.Time, onlyMerchant *uuid.UUID) (DailyBatchReport, error) {
	var merchantIDs []uuid.UUID
	if onlyMerchant != nil {
		merchantIDs = []uuid.UUID{*onlyMerchant}
	} else {
		rows, err := db.Query(ctx, `
			SELECT id FROM merchants WHERE status = 'active' AND test_mode = false ORDER BY id
		`)
		if err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: select merchants: %w", err)
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: scan merchant id: %w", err)
			}
			merchantIDs = append(merchantIDs, id)
		}
		if err := rows.Err(); err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: iterate merchants: %w", err)
		}
		rows.Close()
	}

	sort.Slice(merchantIDs, func(i, j int) bool { return merchantIDs[i].String() < merchantIDs[j].String() })

	return runMerchants(ctx, db, businessDate, merchantIDs)
}

// runMerchants closes and pays out each merchant's batch for businessDate,
// in the order given. A merchant that fails is recorded and skipped, so the
// merchants after it still settle; every failure comes back joined into
// one error.
func runMerchants(ctx context.Context, db *pgxpool.Pool, businessDate time.Time, merchantIDs []uuid.UUID) (DailyBatchReport, error) {
	report := DailyBatchReport{BusinessDate: businessDate}
	var errs []error
	for _, merchantID := range merchantIDs {
		// Shutting down: stop here rather than fail every remaining merchant.
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		closeResult, err := CloseBatch(ctx, db, merchantID, businessDate)
		if err != nil {
			if errors.Is(err, ErrMerchantNotEligible) {
				// A caller passed an explicit --merchant that isn't
				// active/non-test-mode. Skip it, same as the default
				// merchant scan already would have.
				continue
			}
			errs = append(errs, fmt.Errorf("settlement: RunDailyBatch: CloseBatch(%s): %w", merchantID, err))
			continue
		}

		// A merchant with configured sub-merchant split children is paid
		// out across those children rather than as a single lump sum to
		// itself. CloseBatch above is identical either way — only the
		// payout leg differs.
		isSplitParent, err := splits.IsSplitParent(ctx, db, merchantID)
		if err != nil {
			errs = append(errs, fmt.Errorf("settlement: RunDailyBatch: IsSplitParent(%s): %w", merchantID, err))
			continue
		}

		var alreadyPaid bool
		if isSplitParent {
			splitResult, err := splits.PayoutSplitBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				errs = append(errs, fmt.Errorf("settlement: RunDailyBatch: PayoutSplitBatch(%s): %w", closeResult.BatchID, err))
				continue
			}
			alreadyPaid = splitResult.AlreadyPaid
		} else {
			payoutResult, err := PayoutBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				errs = append(errs, fmt.Errorf("settlement: RunDailyBatch: PayoutBatch(%s): %w", closeResult.BatchID, err))
				continue
			}
			alreadyPaid = payoutResult.AlreadyPaid
		}

		report.MerchantResults = append(report.MerchantResults, MerchantBatchOutcome{
			MerchantID:    merchantID,
			BatchID:       closeResult.BatchID,
			AlreadyClosed: closeResult.AlreadyClosed,
			AlreadyPaid:   alreadyPaid,
			GrossFils:     closeResult.GrossFils,
			FeeFils:       closeResult.FeeFils,
			NetPayoutFils: closeResult.NetPayoutFils,
		})
	}

	return report, errors.Join(errs...)
}
