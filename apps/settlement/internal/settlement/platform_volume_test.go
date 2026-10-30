package settlement

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// resetPlatformStats puts the single counter row back at zero, mirroring
// what db/seed/generate.ts's own TRUNCATE + re-INSERT does on every seed.
func resetPlatformStats(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		UPDATE platform_stats SET total_processed_fils = 0, updated_at = now() WHERE id = 1
	`)
	if err != nil {
		t.Fatalf("resetPlatformStats: %v", err)
	}
}

// TestRecordPlatformProcessedVolume_SmallValuesExact proves the
// accumulator is wired correctly: three successive batch closes land on
// the exact integer sum of their gross figures.
func TestRecordPlatformProcessedVolume_SmallValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, gross := range []int64{1_000_000, 2_500_000, 47_500_000} {
		current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
		if err != nil {
			t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
		}
		if err := RecordPlatformProcessedVolume(ctx, tx, current, gross); err != nil {
			t.Fatalf("RecordPlatformProcessedVolume(%d): %v", gross, err)
		}
	}

	var got int32
	err = tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got)
	if err != nil {
		t.Fatalf("read back total: %v", err)
	}
	if got != 51_000_000 {
		t.Fatalf("total_processed_fils = %v, want exactly 51000000 (1000000 + 2500000 + 47500000)", got)
	}
}

// TestVolumeTierMdrBonusBps_BelowAndAtThreshold proves the tier comparison
// is correct on both sides of the threshold.
func TestVolumeTierMdrBonusBps_BelowAndAtThreshold(t *testing.T) {
	if got := VolumeTierMdrBonusBps(0); got != 0 {
		t.Errorf("zero volume: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(1_999_999_999); got != 0 {
		t.Errorf("just below threshold: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(2_000_000_000); got != 15 {
		t.Errorf("exactly at threshold: got %d, want 15", got)
	}
}

// TestRecordPlatformProcessedVolume_PastInt32Max proves the accumulator and
// its column hold a lifetime total above the old INTEGER ceiling
// (2,147,483,647 fils). Before the int64/BIGINT fix the Go cast wrapped the
// sum to a negative value and the INTEGER column could not store it, so the
// volume-tier bonus read a wrong total. The break is silent: nothing errors
// until the platform has processed about 2.1 million BD.
func TestRecordPlatformProcessedVolume_PastInt32Max(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Two closes whose gross together exceed math.MaxInt32 (2,147,483,647).
	for _, gross := range []int64{2_000_000_000, 1_000_000_000} {
		current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
		if err != nil {
			t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
		}
		if err := RecordPlatformProcessedVolume(ctx, tx, current, gross); err != nil {
			t.Fatalf("RecordPlatformProcessedVolume(%d): %v", gross, err)
		}
	}

	var got int64
	err = tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got)
	if err != nil {
		t.Fatalf("read back total: %v", err)
	}
	const want int64 = 3_000_000_000
	if got != want {
		t.Fatalf("total_processed_fils = %d, want %d (no int32 wrap)", got, want)
	}
	if bonus := VolumeTierMdrBonusBps(got); bonus != 15 {
		t.Fatalf("tier bonus at %d fils = %d, want 15", got, bonus)
	}
}
