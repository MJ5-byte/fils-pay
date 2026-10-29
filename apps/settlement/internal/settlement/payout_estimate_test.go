package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// TestUpdateLifetimePayoutMonitoringEstimate_AccumulatesExactly proves the
// accumulator lands on the exact integer sum of its payouts — including one
// well past float32's 2^24 exact-integer limit (33_554_433 fils = 2^25+1),
// which the old REAL column could not represent exactly.
func TestUpdateLifetimePayoutMonitoringEstimate_AccumulatesExactly(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const want = int64(1_000 + 2_500 + 47_500 + 33_554_433)
	for _, net := range []money.Fils{1_000, 2_500, 47_500, 33_554_433} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("UpdateLifetimePayoutMonitoringEstimate(%d): %v", net, err)
		}
	}

	var got int64
	err = tx.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1
	`, merchantID).Scan(&got)
	if err != nil {
		t.Fatalf("read back estimate: %v", err)
	}
	if got != want {
		t.Fatalf("lifetime_net_payout_monitoring_estimate = %d, want exactly %d (1000 + 2500 + 47500 + 33554433)", got, want)
	}
}
