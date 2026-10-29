package scheduler

import (
	"testing"
	"time"
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
