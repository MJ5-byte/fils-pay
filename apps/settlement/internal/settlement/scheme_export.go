package settlement

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// TruncateToSchemeAmount quantizes a captured-fils amount down to the
// nearest 10 fils (2dp granularity), matching the CHECK constraint on
// scheme_export_lines.amount_fils.
//
// — YA: the scheme file only carries two decimals. where does the third go?
// asked twice. told to leave it until after the audit.
func TruncateToSchemeAmount(grossFils money.Fils) money.Fils {
	return (grossFils / 10) * 10
}

// SchemeAmountText is the exact two-decimal BD string stored in
// scheme_export_lines.amount (numeric(10,2)): the truncated amount_fils,
// never the untruncated gross. Passing the gross as a float let the
// numeric(10,2) cast round it up, so the scheme file claimed up to 9 fils
// per line more than amount_fils (ADR-0002 requires truncation).
func SchemeAmountText(grossFils money.Fils) string {
	return formatFilsAsTwoDecimalString(TruncateToSchemeAmount(grossFils))
}

// buildBatchClosedPayload builds the settlement.batch_closed outbox
// payload, following the same shape convention the webhook dispatcher
// depends on for every other event type (a top-level merchantId field,
// required for its webhook_endpoints join to ever match anything).
func buildBatchClosedPayload(
	merchantID, batchID uuid.UUID,
	batchDate time.Time,
	grossFils, feeFils, netPayoutFils money.Fils,
) ([]byte, error) {
	payload := map[string]any{
		"merchantId":    merchantID.String(),
		"batchId":       batchID.String(),
		"batchDate":     batchDate.Format("2006-01-02"),
		"grossFils":     int64(grossFils),
		"feeFils":       int64(feeFils),
		"netPayoutFils": int64(netPayoutFils),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("settlement: marshal batch_closed payload: %w", err)
	}
	return encoded, nil
}

// SchemeExportLine is one already-committed scheme_export_lines row,
// joined with the transaction's acquirer_reference for file export.
type SchemeExportLine struct {
	LineSequence      int32
	AcquirerReference string
	Amount            string // BD, exactly two decimal places, as stored
}

// LoadSchemeExportLines reads the already-written scheme_export_lines
// rows for a batch, ordered by line_sequence. The DB rows, not any file,
// are the durable record — this is a pure read.
func LoadSchemeExportLines(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID) ([]SchemeExportLine, error) {
	rows, err := db.Query(ctx, `
		SELECT sel.line_sequence, t.acquirer_reference,
		       COALESCE(sel.amount, sel.amount_fils::numeric / 1000)::text
		  FROM scheme_export_lines sel
		  JOIN transactions t ON t.id = sel.transaction_id
		 WHERE sel.settlement_batch_id = $1
		 ORDER BY sel.line_sequence
	`, batchID)
	if err != nil {
		return nil, fmt.Errorf("settlement: LoadSchemeExportLines: query: %w", err)
	}
	defer rows.Close()

	var lines []SchemeExportLine
	for rows.Next() {
		var line SchemeExportLine
		if err := rows.Scan(&line.LineSequence, &line.AcquirerReference, &line.Amount); err != nil {
			return nil, fmt.Errorf("settlement: LoadSchemeExportLines: scan: %w", err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settlement: LoadSchemeExportLines: iterate: %w", err)
	}
	return lines, nil
}

// formatFilsAsTwoDecimalString formats an already-2dp-truncated fils
// amount as "D.DD" via integer division and remainder — never
// toFixed-equivalent float division. amount is always a multiple of 10
// fils (the scheme_export_lines CHECK guarantees this for any row loaded
// via LoadSchemeExportLines), so wholeUnits.hundredths always has exactly
// two fractional digits.
func formatFilsAsTwoDecimalString(amount money.Fils) string {
	negative := amount < 0
	abs := amount
	if negative {
		abs = -abs
	}
	wholeUnits := int64(abs) / 1000
	remainderFils := int64(abs) % 1000
	hundredths := remainderFils / 10 // amount is a multiple of 10 fils -> exact
	sign := ""
	if negative {
		sign = "-"
	}
	return fmt.Sprintf("%s%d.%02d", sign, wholeUnits, hundredths)
}

// ExportSchemeFile reads the already-committed scheme_export_lines rows
// for batchID and serializes them to outPath: one line per row —
// acquirer_reference, amount formatted to exactly 2 decimal places,
// currency, line_sequence — comma-separated. Re-running this against the
// same batch produces a byte-identical file every time, because it never
// recomputes anything — it only re-serializes rows that were frozen once,
// at close time.
func ExportSchemeFile(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID, outPath string) (int, error) {
	lines, err := LoadSchemeExportLines(ctx, db, batchID)
	if err != nil {
		return 0, err
	}

	var b strings.Builder
	for _, line := range lines {
		fmt.Fprintf(&b, "%s,%s,%s,%d\n",
			line.AcquirerReference,
			line.Amount,
			"BHD",
			line.LineSequence,
		)
	}

	if err := os.WriteFile(outPath, []byte(b.String()), 0o644); err != nil {
		return 0, fmt.Errorf("settlement: ExportSchemeFile: write %s: %w", outPath, err)
	}

	return len(lines), nil
}
