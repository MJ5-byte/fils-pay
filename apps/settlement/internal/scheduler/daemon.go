// Package scheduler implements the `daemon` subcommand's sleep/wake loop:
// sleeps until the next scheduled run time, then runs the full daily
// batching pass for every active merchant for the business day that just
// completed, then sleeps again. Runs forever until ctx is cancelled
// (main.go wires SIGTERM to cancel it), letting an in-flight batch
// transaction finish (or roll back cleanly) before exiting — no
// transaction is ever left half-committed by a container restart, because
// every batch operation is one Postgres transaction that either fully
// commits or fully rolls back.
package scheduler

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/settlement"
)

// bahrainTime is Asia/Bahrain local time, UTC+3 with no DST since 1972.
var bahrainTime = time.FixedZone("Asia/Bahrain", 3*60*60)

// Run starts the daemon loop. It blocks until ctx is cancelled.
//
// On each wake, it checks whether the current Asia/Bahrain-local wall
// clock has passed cfg.DaemonRunDelayMinutes past local midnight for a
// business day it hasn't yet run, and if so runs RunDailyBatch for each
// merchant on each completed business day, up to yesterday relative to
// Asia/Bahrain "today", that has no paid batch yet, oldest day first.
// CloseBatch/PayoutBatch's own idempotency makes re-running
// the same business date on every wake-up entirely safe — a batch already
// closed/paid is always a no-op — so this loop doesn't need to track "did
// I already run today" state of its own; the settled batches themselves
// say where to resume, and idempotency absorbs the redundant attempts
// between actual new days.
func Run(ctx context.Context, db *pgxpool.Pool, cfg config.Config) {
	log.Printf("settlement daemon: starting, poll interval=%s, run delay=%dm", cfg.DaemonPollInterval, cfg.DaemonRunDelayMinutes)

	// TODO(YA): swap ticker for a cron lib once ops picks one (Dec 2025)
	ticker := time.NewTicker(cfg.DaemonPollInterval)
	defer ticker.Stop()

	// Run once immediately on start (covers a restart that lands after the
	// most recently completed business day's run delay has already
	// elapsed), then on every tick. A container down across several
	// business day boundaries catches up every missed day, up to
	// maxCatchUpDays; an operator recovering from a longer outage backfills
	// the older dates with `settlement run-batch --date=YYYY-MM-DD`, which
	// CloseBatch/PayoutBatch's own idempotency makes safe to run for any
	// past date, processed or not.
	var droppedLogged time.Time
	runIfDue(ctx, db, time.Now(), cfg.DaemonRunDelayMinutes, nil, &droppedLogged)

	for {
		select {
		case <-ctx.Done():
			log.Printf("settlement daemon: shutting down (%v)", ctx.Err())
			return
		case <-ticker.C:
			runIfDue(ctx, db, time.Now(), cfg.DaemonRunDelayMinutes, nil, &droppedLogged)
		}
	}
}

// maxCatchUpDays bounds how many business days one wake-up looks back
// after an outage, so a daemon pointed at a database whose last batch is
// months old does not open a batch for every merchant on every day since.
// Older gaps are backfilled with `settlement run-batch --date`.
const maxCatchUpDays = 31

// runIfDue takes the business date from the Asia/Bahrain calendar date of
// now, so the daily close starts DaemonRunDelayMinutes after Bahrain midnight.
// merchants, when non-nil, limits the run to those merchants; the daemon
// passes nil. droppedLogged remembers the last day reported as past the
// catch-up window, so each day is reported once; nil skips the report.
func runIfDue(ctx context.Context, db *pgxpool.Pool, now time.Time, runDelayMinutes int, merchants []uuid.UUID, droppedLogged *time.Time) {
	// see incident 2026-05-14 -- the missed close that night was the reporting listener dropping NOTIFYs, not this. -- FH
	businessDate, due := dueBusinessDate(now, runDelayMinutes)
	if !due {
		// The grace period after today's Bahrain midnight hasn't elapsed
		// yet; nothing new to do this tick.
		logNextRunEstimate(now)
		return
	}

	// Settle every (day, merchant) the window still owes, oldest day first.
	// Asking per merchant means a merchant signed up later gets no batches
	// before its signup day, a merchant whose batch keeps failing retries
	// only its own days, and a single-merchant run-batch for a later date
	// does not hide the days still owed to the others.
	dueDate := calendarDate(businessDate)
	windowStart := dueDate.AddDate(0, 0, 1-maxCatchUpDays)
	owed, err := owedBatches(ctx, db, windowStart, dueDate, merchants)
	if err != nil {
		log.Printf("settlement daemon: list owed batches: %v", err)
	}
	failed := 0
	for _, o := range owed {
		if ctx.Err() != nil {
			return
		}
		// A failure is logged and left for the next tick; the other
		// merchants and days still run.
		if _, err := settlement.RunDailyBatch(ctx, db, o.day, &o.merchantID); err != nil {
			failed++
			log.Printf("settlement daemon: RunDailyBatch(%s) failed: %v", o.day.Format("2006-01-02"), err)
		}
	}
	if len(owed) > 0 {
		log.Printf("settlement daemon: settled %d of %d owed merchant batch(es) from %s to %s",
			len(owed)-failed, len(owed), owed[0].day.Format("2006-01-02"), dueDate.Format("2006-01-02"))
	}

	// Days that left the window are no longer settled on their own; report
	// the ones still unpaid once, covering every day dropped since the last
	// report (on start, one more window back), and move the marker only
	// once the check has succeeded, so a failed check is retried next tick.
	if lastDropped := windowStart.AddDate(0, 0, -1); droppedLogged != nil && droppedLogged.Before(lastDropped) {
		from := windowStart.AddDate(0, 0, -maxCatchUpDays)
		if next := droppedLogged.AddDate(0, 0, 1); next.After(from) {
			from = next
		}
		left, err := owedBatches(ctx, db, from, lastDropped, merchants)
		if err != nil {
			log.Printf("settlement daemon: list owed batches from %s to %s: %v", from.Format("2006-01-02"), lastDropped.Format("2006-01-02"), err)
		} else {
			*droppedLogged = lastDropped
			if len(left) > 0 {
				log.Printf("settlement daemon: %d merchant batch(es) still unpaid from %s to %s, now past the %d-day catch-up; backfill each date with run-batch --date",
					len(left), left[0].day.Format("2006-01-02"), left[len(left)-1].day.Format("2006-01-02"), maxCatchUpDays)
			}
		}
	}

	// Merchant-facing payout notifications for every batch that has reached
	// 'paid', whichever payout path got it there. Its own NOT EXISTS guard
	// makes running it on every tick a no-op once each batch has been
	// notified, so it needs no "did I already do this" state here, exactly
	// like RunDailyBatch above. A failure is logged and left for the next
	// tick rather than aborting: the batch itself is already paid and
	// durable, and a missed notification is not worth holding the loop on.
	// FH: double settlement.paid if the CLI overlaps -- resolved, see FP-260
	enqueued, err := settlement.EnqueuePayoutNotifications(ctx, db)
	if err != nil {
		log.Printf("settlement daemon: EnqueuePayoutNotifications failed: %v", err)
	} else if enqueued > 0 {
		log.Printf("settlement daemon: enqueued %d settlement.paid event(s)", enqueued)
	}

	logNextRunEstimate(now)
}

// dueBusinessDate reports the business day that has just completed as of
// now, and whether its run delay past Bahrain midnight has elapsed.
func dueBusinessDate(now time.Time, runDelayMinutes int) (businessDate time.Time, due bool) {
	// BusinessDayWindow takes the calendar date in the instant's own zone, so
	// now must be in Bahrain time or the day turns at UTC midnight (03:00 in
	// Bahrain).
	todayStart, _ := settlement.BusinessDayWindow(now.In(bahrainTime))
	dueAt := todayStart.Add(time.Duration(runDelayMinutes) * time.Minute)
	if now.Before(dueAt) {
		return time.Time{}, false
	}
	return todayStart.AddDate(0, 0, -1), true
}

// owedBatch is one merchant's business day that has no paid batch yet.
type owedBatch struct {
	day        time.Time
	merchantID uuid.UUID
}

// owedBatches lists every business day from `from` to `to` on which an
// active merchant, already signed up by that Bahrain day, has no paid
// batch, oldest day first. merchants, when non-nil, limits it to those
// merchants. Each check is one probe of the (merchant_id, batch_date)
// unique index.
func owedBatches(ctx context.Context, db *pgxpool.Pool, from, to time.Time, merchants []uuid.UUID) ([]owedBatch, error) {
	// Dates go over as text so the session time zone cannot shift them.
	rows, err := db.Query(ctx, `
		SELECT d::date, m.id
		  FROM generate_series($1::text::date, $2::text::date, interval '1 day') AS d
		  JOIN merchants m
		    ON m.status = 'active' AND m.test_mode = false
		   AND (m.created_at AT TIME ZONE 'Asia/Bahrain')::date <= d::date
		   AND ($3::uuid[] IS NULL OR m.id = ANY($3::uuid[]))
		 WHERE NOT EXISTS (
		       SELECT 1 FROM settlement_batches b
		        WHERE b.merchant_id = m.id AND b.batch_date = d::date AND b.status = 'paid')
		 ORDER BY d, m.id
	`, from.Format("2006-01-02"), to.Format("2006-01-02"), merchants)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var owed []owedBatch
	for rows.Next() {
		var o owedBatch
		if err := rows.Scan(&o.day, &o.merchantID); err != nil {
			return nil, err
		}
		owed = append(owed, o)
	}
	return owed, rows.Err()
}

// calendarDate keeps only t's calendar date in its own zone, so a Bahrain
// midnight and a UTC-midnight batch_date for the same day compare equal.
func calendarDate(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
