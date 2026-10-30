package settlement

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Platform default MDR: 2.50% (250 basis points).
const defaultMdrBps int64 = 250

// FeeScheduleRow is one merchant's negotiated-rate record, effective from a
// specific instant. Mirrors apps/api/src/fees/feeSchedule.ts's TypeScript
// twin exactly — same table, same resolution rule, so a fee computed at
// capture time and recomputed at settlement time for the same event never
// disagree because the two services picked a different row.
type FeeScheduleRow struct {
	EffectiveFrom time.Time
	MdrBps        int64
}

// LoadFeeSchedules reads a merchant's full fee-schedule history once, in
// ascending effective_from order, so CloseBatch's per-event loop (which may
// need a different row per event, one per calendar day at most in
// practice) never runs one query per event.
func LoadFeeSchedules(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID) ([]FeeScheduleRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT effective_from, mdr_bps FROM fee_schedules
		 WHERE merchant_id = $1
		 ORDER BY effective_from ASC, created_at ASC
	`, merchantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var schedules []FeeScheduleRow
	for rows.Next() {
		var s FeeScheduleRow
		if err := rows.Scan(&s.EffectiveFrom, &s.MdrBps); err != nil {
			return nil, err
		}
		schedules = append(schedules, s)
	}
	return schedules, rows.Err()
}

// EffectiveMdrBpsAt resolves the rate in effect at asOf from an
// already-loaded, ascending-order schedule slice — the newest row whose
// effective_from has already arrived, or fallbackMdrBps (the merchant's
// plain merchants.mdr_bps) when none has. Pure, no I/O, so CloseBatch's
// per-event loop can call it once per event cheaply.
//
// — YA: always resolve against the event's own time. a rate that changes
// next week must not touch anything captured this week, and vice versa.
func EffectiveMdrBpsAt(schedules []FeeScheduleRow, asOf time.Time, fallbackMdrBps int64) int64 {
	// schedules is ascending by construction (LoadFeeSchedules); walk from
	// the end for the newest row that already applies. A binary search would
	// work too, but this list is at most a handful of rows per merchant —
	// a linear scan from the end is the plainer code for that size.
	for i := len(schedules) - 1; i >= 0; i-- {
		if !schedules[i].EffectiveFrom.After(asOf) {
			return schedules[i].MdrBps
		}
	}
	return fallbackMdrBps
}
