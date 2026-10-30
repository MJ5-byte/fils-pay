package settlement

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// insertBatch inserts one settlement_batches row directly, so a test can
// place a batch in an exact (status, net_payout_fils) state without having
// to drive a whole RunDailyBatch pass to get there.
func insertBatch(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate time.Time, status string, netPayoutFils int64) uuid.UUID {
	t.Helper()
	var paidAt any
	if status == "paid" {
		paidAt = time.Now().UTC()
	}
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at)
		VALUES ($1, $2, $3, $4, 0, $4, $5)
		RETURNING id
	`, merchantID, batchDate, status, netPayoutFils, paidAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertBatch: %v", err)
	}
	return id
}

func countPaidEvents(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) int {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM outbox_events
		 WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, batchID).Scan(&n)
	if err != nil {
		t.Fatalf("countPaidEvents: %v", err)
	}
	return n
}

func TestEnqueuePayoutNotificationsEnqueuesOnePerPaidBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	base := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	paidBatch := insertBatch(t, pool, merchantID, base, "paid", 471_300)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}
	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("expected exactly 1 settlement.paid event for the paid batch, got %d", got)
	}

	// The payload the webhook dispatcher's delivery-creation join depends on:
	// merchantId must be present at the top level, or the event matches zero
	// endpoints.
	var merchantIDInPayload uuid.UUID
	var batchDate string
	var netPayoutFils int64
	err := pool.QueryRow(ctx, `
		SELECT (payload->>'merchantId')::uuid, payload->>'batchDate', (payload->>'netPayoutFils')::bigint
		  FROM outbox_events
		 WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, paidBatch).Scan(&merchantIDInPayload, &batchDate, &netPayoutFils)
	if err != nil {
		t.Fatalf("read settlement.paid payload: %v", err)
	}
	if merchantIDInPayload != merchantID {
		t.Fatalf("payload merchantId = %s, want %s", merchantIDInPayload, merchantID)
	}
	if batchDate != "2026-03-02" {
		t.Fatalf("payload batchDate = %q, want %q", batchDate, "2026-03-02")
	}
	if netPayoutFils != 471_300 {
		t.Fatalf("payload netPayoutFils = %d, want 471300", netPayoutFils)
	}
}

// FH: sequential re-run only, concurrent run not covered. todo
func TestEnqueuePayoutNotificationsIsIdempotent(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	paidBatch := insertBatch(t, pool, merchantID, time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC), "paid", 12_500)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("first EnqueuePayoutNotifications: %v", err)
	}
	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("second EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("a second scan must be a no-op; expected 1 settlement.paid event, got %d", got)
	}
}

func TestEnqueuePayoutNotificationsSkipsIneligibleBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	zeroPayout := insertBatch(t, pool, merchantID, time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC), "paid", 0)
	notPaid := insertBatch(t, pool, merchantID, time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC), "closed", 90_000)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, zeroPayout); got != 0 {
		t.Fatalf("a zero-payout batch must not be notified, got %d event(s)", got)
	}
	if got := countPaidEvents(t, pool, notPaid); got != 0 {
		t.Fatalf("a batch that has not reached 'paid' must not be notified, got %d event(s)", got)
	}
}

// Incident 2026-08-21: the daemon tick and a CLI run-batch overlapped and both
// passed the NOT EXISTS check. Run many enqueuers at once; still one event.
func TestEnqueuePayoutNotificationsConcurrentRunsSendOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	paidBatch := insertBatch(t, pool, merchantID, time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC), "paid", 33_000)

	const runners = 8
	var wg sync.WaitGroup
	errs := make(chan error, runners)
	start := make(chan struct{})
	for i := 0; i < runners; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("concurrent runs must enqueue exactly 1 settlement.paid event, got %d", got)
	}
}
