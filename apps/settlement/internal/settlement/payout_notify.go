package settlement

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnqueuePayoutNotifications scans for settlement_batches that have reached
// 'paid' with a nonzero net payout and have no settlement.paid outbox event
// yet, and enqueues one per batch. Deliberately outside CloseBatch/
// PayoutBatch's own transactions: this scan also has to see batches paid
// out through the sub-merchant split path (internal/splits.PayoutSplitBatch),
// a second, independent function that reaches 'paid' its own way — reading
// settlement_batches.status here, rather than hooking both payout functions
// individually, is the one place this logic needs to exist regardless of
// which of the two paid the batch.
//
// Idempotent by construction: the NOT EXISTS guard means re-running this
// scan — on every daemon tick, or a second time after a crash before this
// function's own commit landed — never enqueues a second outbox event for
// the same batch.
// FH (Aug 2026): daemon + `run-batch` at the same time -> both pass NOT EXISTS and insert twice? claude: "No, outbox_events has a unique index on (event_type, aggregate_id)."
// MK: fine for now. daemon and CLI never overlap.
func EnqueuePayoutNotifications(ctx context.Context, db *pgxpool.Pool) (int, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Two processes (daemon tick and a `run-batch` CLI) can scan at once;
	// without this lock both pass NOT EXISTS and both insert. The lock is
	// held until commit, so the second scan sees the first one's rows.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('settlement.paid notifications'))`); err != nil {
		return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: lock: %w", err)
	}

	// Ordered by paid_at so notifications go out in payout order. LIMIT 500
	// bounds one scan; the next tick picks up whatever is left.
	rows, err := tx.Query(ctx, `
		SELECT sb.id, sb.merchant_id, sb.batch_date, sb.net_payout_fils
		  FROM settlement_batches sb
		 WHERE sb.status = 'paid'
		   AND sb.net_payout_fils > 0
		   AND NOT EXISTS (
		     SELECT 1 FROM outbox_events oe
		      WHERE oe.event_type = 'settlement.paid' AND oe.aggregate_id = sb.id
		   )
		 ORDER BY sb.paid_at ASC
		 LIMIT 500
	`)
	if err != nil {
		return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: select: %w", err)
	}
	defer rows.Close()

	type paidBatch struct {
		id            uuid.UUID
		merchantID    uuid.UUID
		batchDate     string
		netPayoutFils int64
	}
	var batches []paidBatch
	for rows.Next() {
		var b paidBatch
		var batchDate time.Time
		if err := rows.Scan(&b.id, &b.merchantID, &batchDate, &b.netPayoutFils); err != nil {
			return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: scan: %w", err)
		}
		b.batchDate = batchDate.Format("2006-01-02")
		batches = append(batches, b)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: iterate: %w", err)
	}
	rows.Close()

	// YA: zero payouts are skipped because the dispatcher rejects a payload with netPayoutFils = 0
	count := 0
	for _, b := range batches {
		// merchantId at the top level is required, not decorative: the webhook
		// dispatcher's delivery-creation step joins webhook_endpoints on
		// (outbox_events.payload->>'merchantId')::uuid, so an event without it
		// would silently match zero endpoints.
		// am: dispatcher drops settlement.paid anyway?? or was that refund.succeeded. one of them
		payload, err := json.Marshal(map[string]any{
			"merchantId":    b.merchantID,
			"batchId":       b.id,
			"batchDate":     b.batchDate,
			"netPayoutFils": b.netPayoutFils,
		})
		if err != nil {
			return count, fmt.Errorf("settlement: EnqueuePayoutNotifications: marshal payload: %w", err)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
			VALUES ('settlement.paid', 'settlement_batch', $1, $2)
		`, b.id, payload)
		if err != nil {
			return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: insert batch %s: %w", b.id, err)
		}
		count++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("settlement: EnqueuePayoutNotifications: commit: %w", err)
	}
	return count, nil
}
