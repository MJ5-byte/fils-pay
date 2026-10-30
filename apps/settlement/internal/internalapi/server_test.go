package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/settlement"
)

const testToken = "test-internal-token"

// mustPool connects to DATABASE_URL or skips the test if it isn't set —
// the same convention internal/settlement and internal/ledger's tests use
// (their helpers are unexported, so this package cannot import them).
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

// newTestServer starts the real handler over httptest. pool may be nil for
// tests that never reach a handler body (auth and request-parsing tests).
func newTestServer(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(Handler(pool, config.Config{InternalToken: testToken}))
	t.Cleanup(server.Close)
	return server
}

func post(t *testing.T, server *httptest.Server, path, authHeader, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func insertActiveMerchant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false)
		RETURNING id
	`, "internalapi-test-"+uuid.New().String()).Scan(&id)
	if err != nil {
		t.Fatalf("insertActiveMerchant: %v", err)
	}
	return id
}

// insertCaptureEvent inserts the transactions + transaction_events +
// ledger_entries rows a real capture would have produced, so a batch run
// over the merchant has something to settle.
func insertCaptureEvent(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils int64, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var txnID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, amountFils, "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert transaction: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'captured', $2, 'system', $3)
	`, txnID, amountFils, occurredAt)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert transaction_events: %v", err)
	}

	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $5, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: gross')
	`, groupID, merchantID, txnID, amountFils, occurredAt)
	if err != nil {
		t.Fatalf("insertCaptureEvent: insert gross ledger legs: %v", err)
	}

	return txnID
}

func decodeJSON(t *testing.T, resp *http.Response, into any) {
	t.Helper()
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
}

func TestRunBatch_ValidTokenAndDate(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, _ := settlement.BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 10000, start.Add(time.Hour))

	body := `{"date":"2026-04-10","merchantId":"` + merchantID.String() + `"}`
	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var report runBatchResponse
	decodeJSON(t, resp, &report)

	if report.BusinessDate != "2026-04-10" {
		t.Errorf("businessDate = %q, want %q", report.BusinessDate, "2026-04-10")
	}
	if len(report.MerchantResults) != 1 {
		t.Fatalf("merchantResults length = %d, want 1", len(report.MerchantResults))
	}
	result := report.MerchantResults[0]
	if result.MerchantID != merchantID.String() {
		t.Errorf("merchantId = %q, want %q", result.MerchantID, merchantID)
	}
	if _, err := uuid.Parse(result.BatchID); err != nil {
		t.Errorf("batchId = %q, want a UUID: %v", result.BatchID, err)
	}
	if result.GrossFils != 10000 {
		t.Errorf("grossFils = %d, want 10000", result.GrossFils)
	}
	// 2.50% MDR on 10000 fils, recomputed per event.
	if result.FeeFils != 250 {
		t.Errorf("feeFils = %d, want 250", result.FeeFils)
	}
	if result.NetPayoutFils != result.GrossFils-result.FeeFils {
		t.Errorf("netPayoutFils = %d, want %d", result.NetPayoutFils, result.GrossFils-result.FeeFils)
	}

	// The HTTP path must leave exactly the same DB state the CLI path
	// does: the batch is closed and paid out.
	var status string
	err := pool.QueryRow(context.Background(), `SELECT status FROM settlement_batches WHERE id = $1`, result.BatchID).Scan(&status)
	if err != nil {
		t.Fatalf("query batch status: %v", err)
	}
	if status != "paid" {
		t.Errorf("settlement_batches.status = %q, want %q", status, "paid")
	}
}

// TestRunBatch_MerchantScopedOnlyAffectsThatMerchant verifies the
// merchantId field really scopes the run: a second, equally eligible
// merchant with events on the same business date must be left untouched.
func TestRunBatch_MerchantScopedOnlyAffectsThatMerchant(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	targetID := insertActiveMerchant(t, pool)
	otherID := insertActiveMerchant(t, pool)
	businessDate := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	start, _ := settlement.BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, targetID, 7000, start.Add(time.Hour))
	insertCaptureEvent(t, pool, otherID, 8000, start.Add(time.Hour))

	body := `{"date":"2026-04-11","merchantId":"` + targetID.String() + `"}`
	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var report runBatchResponse
	decodeJSON(t, resp, &report)

	if len(report.MerchantResults) != 1 {
		t.Fatalf("merchantResults length = %d, want 1 (only the scoped merchant)", len(report.MerchantResults))
	}
	if report.MerchantResults[0].MerchantID != targetID.String() {
		t.Errorf("merchantId = %q, want the scoped merchant %q", report.MerchantResults[0].MerchantID, targetID)
	}

	var otherBatchCount int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM settlement_batches WHERE merchant_id = $1
	`, otherID).Scan(&otherBatchCount)
	if err != nil {
		t.Fatalf("query other merchant's batches: %v", err)
	}
	if otherBatchCount != 0 {
		t.Errorf("the unscoped merchant got %d settlement_batches row(s), want 0", otherBatchCount)
	}

	var otherBatchedEvents int
	err = pool.QueryRow(context.Background(), `
		SELECT count(*) FROM transaction_events te
		  JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NOT NULL
	`, otherID).Scan(&otherBatchedEvents)
	if err != nil {
		t.Fatalf("query other merchant's batched events: %v", err)
	}
	if otherBatchedEvents != 0 {
		t.Errorf("the unscoped merchant had %d event(s) marked batched, want 0", otherBatchedEvents)
	}
}

// The button must agree with the CLI: rebuild from the ledger (capture
// 12000 credited, fee 300 debited = 11700), not from scheme export lines
// (12000 gross, which ignores fees and payouts).
func TestRebuildBalances_ValidToken(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	insertCaptureEvent(t, pool, merchantID, 12000, time.Date(2026, 4, 12, 9, 0, 0, 0, time.UTC))

	// A deliberately drifted cached value, so this merchant's entry is a
	// changed one.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 999999, now())
		ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 999999
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	// A fee leg, so the ledger figure (11700) differs from the scheme
	// export gross (12000) and the test can tell the two sources apart.
	_, err = pool.Exec(context.Background(), `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable',     'debit',  300, now(), 'test: fee'),
		  ($1, $2, 'platform_fee_revenue', 'credit', 300, now(), 'test: fee')
	`, uuid.New(), merchantID)
	if err != nil {
		t.Fatalf("seed fee leg: %v", err)
	}

	// A scheme-export line for the same batch: the old (wrong) source.
	var batchID uuid.UUID
	err = pool.QueryRow(context.Background(), `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-04-12', 'closed', 12000, 300, 11700, now())
		RETURNING id
	`, merchantID).Scan(&batchID)
	if err != nil {
		t.Fatalf("seed settlement batch: %v", err)
	}
	_, err = pool.Exec(context.Background(), `
		INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
		SELECT $1, id, 12000, 1 FROM transactions WHERE merchant_id = $2 LIMIT 1
	`, batchID, merchantID)
	if err != nil {
		t.Fatalf("seed scheme export line: %v", err)
	}

	resp := post(t, server, "/internal/rebuild-balances", "Bearer "+testToken, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var diffs map[string]rebuildDiffResponse
	decodeJSON(t, resp, &diffs)

	diff, ok := diffs[merchantID.String()]
	if !ok {
		t.Fatalf("response has no diff entry for merchant %s", merchantID)
	}
	if diff.MerchantID != merchantID.String() {
		t.Errorf("merchantId = %q, want %q", diff.MerchantID, merchantID)
	}
	if diff.Before != 999999 {
		t.Errorf("before = %d, want 999999 (the drifted cached value)", diff.Before)
	}
	if diff.After != 11700 {
		t.Errorf("after = %d, want 11700 (the ledger: capture minus fee), not 12000 (scheme export gross)", diff.After)
	}
	if !diff.Changed {
		t.Error("changed = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != 11700 {
		t.Errorf("persisted cached_payable_fils = %d, want 11700 (the ledger)", persisted)
	}
}

// am: an empty expected token lets an empty bearer through, needs a test
func TestAuth_RejectsMissingAndWrongTokens(t *testing.T) {
	server := newTestServer(t, nil)

	paths := []string{"/internal/run-batch", "/internal/rebuild-balances"}
	authHeaders := []struct {
		name   string
		header string
	}{
		{"missing header", ""},
		{"wrong token", "Bearer wrong-token"},
		{"empty token", "Bearer "},
		{"token with no scheme", testToken},
		{"wrong scheme", "Basic " + testToken},
		{"correct token as a prefix", "Bearer " + testToken + "-extra"},
	}

	for _, path := range paths {
		for _, auth := range authHeaders {
			t.Run(path+"/"+auth.name, func(t *testing.T) {
				// A valid body, so only the auth check can be the reason
				// for a non-200.
				resp := post(t, server, path, auth.header, `{"date":"2026-04-10"}`)
				if resp.StatusCode != http.StatusUnauthorized {
					t.Errorf("status = %d, want 401", resp.StatusCode)
				}
			})
		}
	}
}

func TestRunBatch_MalformedDate(t *testing.T) {
	server := newTestServer(t, nil)

	cases := []struct {
		name string
		body string
	}{
		{"not a date", `{"date":"not-a-date"}`},
		{"wrong format", `{"date":"10/04/2026"}`},
		{"impossible day", `{"date":"2026-02-30"}`},
		{"missing date", `{}`},
		{"empty date", `{"date":""}`},
		{"malformed json", `{"date":`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, tc.body)
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", resp.StatusCode)
			}
		})
	}
}

func TestRunBatch_MalformedMerchantID(t *testing.T) {
	server := newTestServer(t, nil)
	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, `{"date":"2026-04-10","merchantId":"not-a-uuid"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestNonPostMethodRejected(t *testing.T) {
	server := newTestServer(t, nil)
	for _, path := range []string{"/internal/run-batch", "/internal/rebuild-balances"} {
		req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("GET %s status = %d, want 405", path, resp.StatusCode)
		}
	}
}

// TestServe_ShutsDownWithContext verifies Serve stops cleanly (returning
// nil) when the daemon's context is cancelled, which is how
// SIGTERM/SIGINT reaches it. Port 0 asks the OS for any free port, so this
// test never collides with a running daemon.
func TestServe_ShutsDownWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, nil, config.Config{InternalPort: 0, InternalToken: testToken})
	}()

	// Give the listener a moment to come up before cancelling.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Serve returned %v, want nil after a graceful shutdown", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return within 10s of its context being cancelled")
	}
}
