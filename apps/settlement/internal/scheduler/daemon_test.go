package scheduler

import (
	"context"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDueBusinessDate(t *testing.T) {
	bahrain := time.FixedZone("UTC+3", 3*60*60)

	tests := []struct {
		name    string
		now     time.Time
		wantDue bool
		want    string
	}{
		{
			// 21:05 UTC on 29 Oct: the UTC day has not turned, but the
			// Bahrain day of 29 Oct ended five minutes ago.
			name:    "inside the run delay after Bahrain midnight",
			now:     time.Date(2026, 10, 30, 0, 5, 0, 0, bahrain).UTC(),
			wantDue: false,
		},
		{
			name:    "after the run delay, before UTC midnight",
			now:     time.Date(2026, 10, 30, 0, 20, 0, 0, bahrain).UTC(),
			wantDue: true,
			want:    "2026-10-29",
		},
		{
			name:    "late in the Bahrain day",
			now:     time.Date(2026, 10, 30, 23, 50, 0, 0, bahrain).UTC(),
			wantDue: true,
			want:    "2026-10-29",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			businessDate, due := dueBusinessDate(tc.now, 15)
			if due != tc.wantDue {
				t.Fatalf("dueBusinessDate(%s) due = %v, want %v", tc.now.Format(time.RFC3339), due, tc.wantDue)
			}
			if !due {
				return
			}
			if got := businessDate.Format("2006-01-02"); got != tc.want {
				t.Fatalf("dueBusinessDate(%s) = %s, want %s", tc.now.Format(time.RFC3339), got, tc.want)
			}
		})
	}
}

// mustPool connects to DATABASE_URL or skips, like the settlement package's
// DB-backed tests.
func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (run against a real, migrated Postgres)")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("failed to connect to DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// insertCapture adds one captured transaction and its capture event, which
// is all CloseBatch reads.
func insertCapture(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils int64, occurredAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var txnID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, amountFils, "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID)
	if err != nil {
		t.Fatalf("insertCapture: insert transaction: %v", err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'captured', $2, 'system', $3)
	`, txnID, amountFils, occurredAt)
	if err != nil {
		t.Fatalf("insertCapture: insert transaction_events: %v", err)
	}
}

// insertMerchant adds an active merchant that signed up at createdAt and
// suspends it when the test ends, so later all-merchant runs in the shared
// test database leave it alone.
func insertMerchant(t *testing.T, pool *pgxpool.Pool, id uuid.UUID, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchants (id, display_name, mdr_bps, status, test_mode, created_at)
		VALUES ($1, $2, 250, 'active', false, $3)
	`, id, "scheduler-test-"+id.String(), createdAt)
	if err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `UPDATE merchants SET status = 'suspended' WHERE id = $1`, id); err != nil {
			t.Errorf("suspend test merchant: %v", err)
		}
	})
}

// A daemon that was down across several Bahrain midnights must settle every
// day each merchant missed when it comes back, not only the most recent
// one; must not open batches before a merchant signed up; and must not let
// one merchant's failing day stop the other merchants or days. The batch
// work is scoped to this test's merchants so it leaves every other merchant
// in the shared test database alone; EnqueuePayoutNotifications, which
// runIfDue also calls, is global and queues settlement.paid for any paid
// batch in the database not yet notified.
func TestRunIfDue_CatchesUpEveryMissedDay(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	day := func(d int) time.Time { return time.Date(2026, 2, d, 0, 0, 0, 0, time.UTC) }
	// The daemon's clock, 20 minutes after the Bahrain midnight that ends businessDate.
	wakeAfter := func(businessDate time.Time) time.Time {
		return time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day()+1, 0, 20, 0, 0, bahrainTime)
	}
	at := func(businessDate time.Time, hour int) time.Time {
		return time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day(), hour, 0, 0, 0, bahrainTime)
	}

	// The daemon walks merchants in id order, so the failing one gets the
	// smallest id and comes first on its failing day.
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	failing, early, late := ids[0], ids[1], ids[2]
	insertMerchant(t, pool, failing, at(day(10), 9))
	insertMerchant(t, pool, early, at(day(10), 9))
	insertMerchant(t, pool, late, at(day(12), 9))

	// The daemon settles 10 Feb on time, then stays down for three days.
	insertCapture(t, pool, early, 500, at(day(10), 12))
	runIfDue(ctx, pool, wakeAfter(day(10)), 15, ids, nil)
	insertCapture(t, pool, early, 1000, at(day(11), 12))
	insertCapture(t, pool, early, 2000, at(day(12), 12))
	insertCapture(t, pool, early, 3000, at(day(13), 12))
	insertCapture(t, pool, late, 700, at(day(12), 12))
	insertCapture(t, pool, late, 800, at(day(13), 12))
	// This merchant's close for 11 Feb fails and rolls back.
	refuseBatchInsert(t, pool, failing, day(11))
	insertCapture(t, pool, failing, 900, at(day(11), 12))
	runIfDue(ctx, pool, wakeAfter(day(13)), 15, ids, nil)

	paid := []struct {
		name     string
		merchant uuid.UUID
		day      int
		gross    int64
	}{
		{"early 10 Feb", early, 10, 500},
		{"early 11 Feb, after the failing merchant", early, 11, 1000},
		{"early 12 Feb", early, 12, 2000},
		{"early 13 Feb", early, 13, 3000},
		{"late 12 Feb, its signup day", late, 12, 700},
		{"late 13 Feb", late, 13, 800},
		{"failing 12 Feb, after its own failed day", failing, 12, 0},
		{"failing 13 Feb", failing, 13, 0},
	}
	for _, tc := range paid {
		var status string
		var gross int64
		err := pool.QueryRow(ctx, `
			SELECT status, gross_fils FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2
		`, tc.merchant, day(tc.day)).Scan(&status, &gross)
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if status != "paid" || gross != tc.gross {
			t.Errorf("%s: batch is %s with gross %d, want paid with gross %d", tc.name, status, gross, tc.gross)
		}
	}

	if n := countBatches(t, pool, late, `batch_date < $2`, day(12)); n != 0 {
		t.Errorf("late merchant has %d batch(es) before its signup day, want 0", n)
	}
	if n := countBatches(t, pool, failing, `batch_date = $2 AND status = 'paid'`, day(11)); n != 0 {
		t.Errorf("failing merchant's 11 Feb batch was paid, want it left unpaid")
	}
}

func countBatches(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, where string, date time.Time) int {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM settlement_batches WHERE merchant_id = $1 AND `+where, merchantID, date).Scan(&n)
	if err != nil {
		t.Fatalf("count batches: %v", err)
	}
	return n
}

// refuseBatchInsert makes CloseBatch fail for one merchant and business date
// only: a test-only trigger rejects that merchant's settlement_batches insert
// for that date, so its close rolls back. Dropped when the test ends.
func refuseBatchInsert(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) {
	t.Helper()
	ctx := context.Background()
	// DDL takes no bind parameters; the id and date come from the test itself.
	name := "test_refuse_batch_" + strings.ReplaceAll(merchantID.String(), "-", "")
	_, err := pool.Exec(ctx, `CREATE FUNCTION `+name+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test: batch insert refused'; END $$`)
	if err != nil {
		t.Fatalf("refuseBatchInsert: create function: %v", err)
	}
	_, err = pool.Exec(ctx, `CREATE TRIGGER `+name+` BEFORE INSERT ON settlement_batches FOR EACH ROW
		WHEN (NEW.merchant_id = '`+merchantID.String()+`' AND NEW.batch_date = '`+businessDate.Format("2006-01-02")+`')
		EXECUTE FUNCTION `+name+`()`)
	if err != nil {
		t.Fatalf("refuseBatchInsert: create trigger: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+name+` ON settlement_batches`); err != nil {
			t.Errorf("drop trigger: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+name+`()`); err != nil {
			t.Errorf("drop function: %v", err)
		}
	})
}
