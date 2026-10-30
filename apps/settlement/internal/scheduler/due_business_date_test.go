package scheduler

import (
	"testing"
	"time"
)

// Finance memo: "The daily close is running at 3am local, not midnight."
// The close for a Bahrain business day must become due runDelay minutes
// after Bahrain midnight (UTC+3), not after UTC midnight.
func TestDueBusinessDate_BahrainMidnight(t *testing.T) {
	const delay = 15
	cases := []struct {
		name     string
		now      time.Time
		wantDate string
		wantDue  bool
	}{
		// 00:05 Bahrain on the 15th: before the grace period.
		{"before grace", time.Date(2026, 5, 14, 21, 5, 0, 0, time.UTC), "2026-05-14", false},
		// 00:20 Bahrain on the 15th: the 14th's close is due now (the old
		// code wouldn't run it until 00:15 UTC = 03:15 Bahrain).
		{"after grace", time.Date(2026, 5, 14, 21, 20, 0, 0, time.UTC), "2026-05-14", true},
		// 03:20 Bahrain on the 15th: still the 14th, still due.
		{"next UTC day", time.Date(2026, 5, 15, 0, 20, 0, 0, time.UTC), "2026-05-14", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			date, due := dueBusinessDate(tc.now, delay)
			if got := date.Format("2006-01-02"); got != tc.wantDate || due != tc.wantDue {
				t.Errorf("dueBusinessDate(%s) = (%s, %v), want (%s, %v)",
					tc.now.Format(time.RFC3339), got, due, tc.wantDate, tc.wantDue)
			}
		})
	}
}
