// Package settlement implements the daily per-merchant batching algorithm:
// eligible-event selection, MDR fee
// recomputation, scheme export line generation, and the payout ledger
// posting.
package settlement

import (
	"fmt"
	"time"
)

// businessDayLocation is the settlement business day's fixed timezone:
// Asia/Bahrain local time (UTC+3, no DST — Bahrain has observed no
// daylight-saving transitions since 1972), loaded as a named IANA zone and
// held in an unexported package var, never read from configuration.
//
// Why hardcoded rather than configurable: FilsPay settles Bahraini Dinar;
// the merchants and the card-scheme relationship this platform models are
// Bahrain-based. A "settlement business day" has to close at this
// platform's local midnight, not the host machine's or the deploying
// engineer's. There is exactly one place this value is defined, and no
// config or TZ variable can change it.
//
// — YA: it's Asia/Bahrain.
var businessDayLocation = mustLoadLocation("Asia/Bahrain")

// mustLoadLocation panics at package init if the zone cannot be loaded.
// cmd/settlement imports time/tzdata, so it cannot fail in the shipped binary.
func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("settlement: failed to load timezone %q: %v", name, err))
	}
	return loc
}

// BusinessDate returns the Asia/Bahrain calendar date of the instant t, as a
// midnight-UTC time.Time carrying only that Y/M/D (the convention the CLI's
// --date flag uses). Callers that start from "now" MUST go through this:
// BusinessDayWindow reads the Y/M/D of whatever location its argument is in,
// so handing it a UTC instant between 21:00 and 24:00 UTC yields the wrong
// (previous) Bahrain business day.
func BusinessDate(t time.Time) time.Time {
	y, m, d := t.In(businessDayLocation).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// BusinessDayWindow returns the [start, end) UTC instants bounding the
// given calendar date's Asia/Bahrain business day, i.e. Asia/Bahrain
// 00:00:00 on `date` through Asia/Bahrain 00:00:00 on `date`+1.
// Bahrain has no DST, so the window is always exactly 24h.
func BusinessDayWindow(date time.Time) (start, end time.Time) {
	// Only the calendar date (Y/M/D, in date's own location) is used; derive it
	// from an instant with BusinessDate.
	y, m, d := date.Date()
	start = time.Date(y, m, d, 0, 0, 0, 0, businessDayLocation)
	end = start.AddDate(0, 0, 1)
	return start, end
}
