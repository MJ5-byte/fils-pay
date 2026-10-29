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
// business day it hasn't yet run, and if so runs RunDailyBatch for that
// completed business day (yesterday, relative to Asia/Bahrain "today").
// CloseBatch/PayoutBatch's own idempotency makes re-running
// the same business date on every wake-up entirely safe — a batch already
// closed/paid is always a no-op — so this loop doesn't need to track "did
// I already run today" state of its own; it simply always attempts the
// most recently completed business day, and idempotency absorbs the
// redundant attempts between actual new days.
func Run(ctx context.Context, db *pgxpool.Pool, cfg config.Config) {
	log.Printf("settlement daemon: starting, poll interval=%s, run delay=%dm", cfg.DaemonPollInterval, cfg.DaemonRunDelayMinutes)

	// TODO(YA): swap ticker for a cron lib once ops picks one (Dec 2025)
	ticker := time.NewTicker(cfg.DaemonPollInterval)
	defer ticker.Stop()

	// Run once immediately on start (covers a restart that lands after the
	// most recently completed business day's run delay has already
	// elapsed), then on every tick. A container down across more than one
	// business day boundary only catches up the single most recent one
	// here — an operator recovering from a longer outage backfills the
	// earlier missed dates with `settlement run-batch --date=YYYY-MM-DD`,
	// which CloseBatch/PayoutBatch's own idempotency makes safe to run for
	// any past date, processed or not.
	runIfDue(ctx, db, cfg.DaemonRunDelayMinutes)

	for {
		select {
		case <-ctx.Done():
			log.Printf("settlement daemon: shutting down (%v)", ctx.Err())
			return
		case <-ticker.C:
			runIfDue(ctx, db, cfg.DaemonRunDelayMinutes)
		}
	}
}

// runIfDue takes the business date from the Asia/Bahrain calendar date of
// now, so the daily close starts DaemonRunDelayMinutes after Bahrain midnight.
func runIfDue(ctx context.Context, db *pgxpool.Pool, runDelayMinutes int) {
	// see incident 2026-05-14 -- the missed close that night was the reporting listener dropping NOTIFYs, not this. -- FH
	now := time.Now().UTC()
	businessDate, due := dueBusinessDate(now, runDelayMinutes)
	if !due {
		// The grace period after today's Bahrain midnight hasn't elapsed
		// yet; nothing new to do this tick.
		logNextRunEstimate(now)
		return
	}

	report, err := settlement.RunDailyBatch(ctx, db, businessDate, nil)
	if err != nil {
		log.Printf("settlement daemon: RunDailyBatch(%s) failed: %v", businessDate.Format("2006-01-02"), err)
		return
	}
	log.Printf("settlement daemon: RunDailyBatch(%s) processed %d merchant(s)", businessDate.Format("2006-01-02"), len(report.MerchantResults))

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
