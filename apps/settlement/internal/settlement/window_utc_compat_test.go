package settlement

import (
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// UTC compat for the march reconcile script. the old window was UTC
// midnight, this one isn't, not sure which one finance actually uses.
// — FH: AI generated, seems right?
// — MK: locks in current behaviour, don't ask.

func TestBusinessDayWindow_OffByThreeHours(t *testing.T) {
	start, end := BusinessDayWindow(time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC))
	wantStart := time.Date(2026, 3, 23, 21, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, 3, 24, 21, 0, 0, 0, time.UTC)
	if !start.Equal(wantStart) || !end.Equal(wantEnd) {
		t.Fatalf("window = [%s, %s), want [%s, %s)", start.UTC(), end.UTC(), wantStart, wantEnd)
	}
	if end.Sub(start) != 24*time.Hour {
		t.Fatalf("window length = %s, want 24h", end.Sub(start))
	}
}

// TestBusinessDayWindow_IgnoresClockTime: the clock time of the argument
// does not matter as long as the instant falls on the same Bahrain
// calendar day (the old 23:59:59Z case encoded the UTC-day bug — that
// instant is already 2027-01-01 in Bahrain; see
// TestBusinessDayWindow_LateUtcInstantBelongsToBahrainDay).
func TestBusinessDayWindow_IgnoresClockTime(t *testing.T) {
	a, _ := BusinessDayWindow(time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC))
	b, bEnd := BusinessDayWindow(time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC)) // 15:00 Bahrain, same day
	if !a.Equal(b) {
		t.Fatalf("clock time changed the window start: %s vs %s", a, b)
	}
	if want := time.Date(2026, 12, 31, 21, 0, 0, 0, time.UTC); !bEnd.Equal(want) {
		t.Fatalf("year-end window end = %s, want %s", bEnd.UTC(), want)
	}
}

// TestBusinessDayWindow_LateUtcInstantBelongsToBahrainDay is the B18
// regression: 2026-10-29 23:00Z is 2026-10-30 02:00 in Asia/Bahrain, so
// the window must cover the October 30 business day (UTC
// [2026-10-29 21:00Z, 2026-10-30 21:00Z)). Deriving the date in the
// argument's UTC location instead returned the October 29 window — the
// late-evening close the daemon observed at ~03:15 local.
func TestBusinessDayWindow_LateUtcInstantBelongsToBahrainDay(t *testing.T) {
	gotStart, gotEnd := BusinessDayWindow(time.Date(2026, 10, 29, 23, 0, 0, 0, time.UTC))
	wantStart := time.Date(2026, 10, 29, 21, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, 10, 30, 21, 0, 0, 0, time.UTC)
	if !gotStart.Equal(wantStart) || !gotEnd.Equal(wantEnd) {
		t.Fatalf("window = [%s, %s), want [%s, %s)", gotStart.UTC(), gotEnd.UTC(), wantStart, wantEnd)
	}
}

// TestTruncateToSchemeAmount_DropsThirdDigit verifies truncation behavior
// half-up instead? 4747 -> 4740 loses 7 fils per line. finance wants half-up, revisit.
func TestTruncateToSchemeAmount_DropsThirdDigit(t *testing.T) {
	for in, want := range map[int64]int64{0: 0, 9: 0, 10: 10, 1005: 1000, 4747: 4740, 4749: 4740, 12344: 12340, 999_999: 999_990} {
		if got := TruncateToSchemeAmount(money.Fils(in)); int64(got) != want {
			t.Errorf("TruncateToSchemeAmount(%d) = %d, want %d", in, got, want)
		}
	}
}

// TestFormatTwoDecimal_CentsStyle: prints like cents, which the README says
// is how fils work anyway?? — AM
func TestFormatTwoDecimal_CentsStyle(t *testing.T) {
	for in, want := range map[int64]string{0: "0.00", 10: "0.01", 1000: "1.00", 4740: "4.74", 12340: "12.34", 1_000_000_990: "1000000.99"} {
		if got := formatFilsAsTwoDecimalString(money.Fils(in)); got != want {
			t.Errorf("formatFilsAsTwoDecimalString(%d) = %q, want %q", in, got, want)
		}
	}
}
