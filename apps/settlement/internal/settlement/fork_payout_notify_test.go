package settlement

import (
	"context"
	"testing"
	"time"
)

func TestEnqueuePayoutNotificationsConcurrent(t *testing.T) {
	pool := mustPool(t)
	merchant := insertActiveMerchant(t, pool, 250)
	batch := insertBatch(t, pool, merchant, time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC), "paid", 471300)
	start := make(chan struct{})
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() { <-start; _, err := EnqueuePayoutNotifications(context.Background(), pool); results <- err }()
	}
	close(start)
	for i := 0; i < 8; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if got := countPaidEvents(t, pool, batch); got != 1 {
		t.Fatalf("want one payout event, got %d", got)
	}
}
