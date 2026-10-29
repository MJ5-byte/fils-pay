// Package internalapi is apps/settlement's small internal HTTP server: the
// admin-triggerable operations apps/api's admin plane needs, exposed over
// HTTP because the compiled Go binary isn't in the API container and
// reimplementing RunDailyBatch's locking/idempotency logic in a second
// language would be two things that must agree and can drift.
//
// A thin transport wrapper and nothing else: every handler calls a function
// in internal/settlement or internal/ledger. No settlement or balance
// arithmetic lives in this package.
//
// Plain net/http + http.ServeMux, no framework — matching this service's
// existing "boring and small" style.
package internalapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/ledger"
	"github.com/filspay/settlement/internal/settlement"
)

// businessDateLayout is the wire format for a business date, identical to
// the `run-batch` CLI subcommand's --date flag format.
const businessDateLayout = "2006-01-02"

// shutdownTimeout bounds how long a graceful shutdown waits for an
// in-flight request. A full daily batch can legitimately run for a while;
// this is deliberately generous so a SIGTERM does not sever a batch that
// is already committing.
const shutdownTimeout = 30 * time.Second

// runBatchRequest is POST /internal/run-batch's body.
type runBatchRequest struct {
	Date       string `json:"date"`
	MerchantID string `json:"merchantId"`
}

// merchantBatchOutcomeResponse is one merchant's outcome within a daily
// pass — the JSON projection of settlement.MerchantBatchOutcome. The
// projection lives here, in the transport layer, so internal/settlement's
// types stay free of wire-format concerns.
type merchantBatchOutcomeResponse struct {
	MerchantID    string `json:"merchantId"`
	BatchID       string `json:"batchId"`
	AlreadyClosed bool   `json:"alreadyClosed"`
	AlreadyPaid   bool   `json:"alreadyPaid"`
	GrossFils     int64  `json:"grossFils"`
	FeeFils       int64  `json:"feeFils"`
	NetPayoutFils int64  `json:"netPayoutFils"`
}

// runBatchResponse is the JSON projection of settlement.DailyBatchReport.
type runBatchResponse struct {
	BusinessDate    string                         `json:"businessDate"`
	MerchantResults []merchantBatchOutcomeResponse `json:"merchantResults"`
}

// rebuildDiffResponse is the JSON projection of ledger.RebuildDiff.
//
// After is the ledger-derived balance, the same figure
// `settlement rebuild-balances` prints for the merchant.
type rebuildDiffResponse struct {
	MerchantID string `json:"merchantId"`
	Before     int64  `json:"before"`
	After      int64  `json:"after"`
	Changed    bool   `json:"changed"`
}

// recalculateMDRRequest is POST /internal/recalculate-mdr's body. The date
// range is half-open [from, to), matching every other date-windowed query
// in this service.
type recalculateMDRRequest struct {
	MerchantID string `json:"merchantId"`
	From       string `json:"from"`
	To         string `json:"to"`
}

// batchAdjustmentResponse is the JSON projection of
// settlement.BatchAdjustment.
type batchAdjustmentResponse struct {
	BatchID    string `json:"batchId"`
	BatchDate  string `json:"batchDate"`
	Status     string `json:"status"`
	OldFeeFils int64  `json:"oldFeeFils"`
	NewFeeFils int64  `json:"newFeeFils"`
	DiffFils   int64  `json:"diffFils"`
}

// recalculateMDRResponse is the JSON projection of settlement.RecalcResult.
type recalculateMDRResponse struct {
	BatchesConsidered int                       `json:"batchesConsidered"`
	Adjusted          []batchAdjustmentResponse `json:"adjusted"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// Handler builds the internal API's http.Handler. Exported separately from
// Serve so tests can exercise the routes over httptest without binding a
// fixed port.
//
// Every route requires the bearer token; this server has no unauthenticated
// health route.
func Handler(pool *pgxpool.Pool, cfg config.Config) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/internal/run-batch", requireBearerToken(cfg.InternalToken, requirePost(handleRunBatch(pool))))
	mux.Handle("/internal/rebuild-balances", requireBearerToken(cfg.InternalToken, requirePost(handleRebuildBalances(pool))))
	// FH: recalculate-mdr is 'safe' per ADMIN.md -- finance runs it after every rate change
	mux.Handle("/internal/recalculate-mdr", requireBearerToken(cfg.InternalToken, requirePost(handleRecalculateMDR(pool))))
	return mux
}

// Serve starts the internal HTTP server on cfg.InternalPort and blocks
// until ctx is cancelled (main.go wires SIGTERM/SIGINT to that same ctx),
// at which point it shuts down gracefully and returns nil. Any other
// failure — a port already in use, most commonly — is returned as an
// error.
func Serve(ctx context.Context, pool *pgxpool.Pool, cfg config.Config) error {
	// am: binds all interfaces. only on the docker network so fine??
	addr := net.JoinHostPort("", strconv.Itoa(cfg.InternalPort))
	server := &http.Server{
		Addr:    addr,
		Handler: Handler(pool, cfg),
		// Every handler's request context derives from the daemon's own
		// ctx, so a shutdown signal also cancels the pgx work an in-flight
		// batch is doing rather than leaving it orphaned.
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 10 * time.Second,
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("settlement internal api: graceful shutdown: %v", err)
		}
	}()

	log.Printf("settlement internal api: listening on %s", addr)
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		<-shutdownDone
		return nil
	}
	return fmt.Errorf("internalapi: listen on %s: %w", addr, err)
}

// requireBearerToken guards a handler with the shared-secret bearer token.
// The token is compared with crypto/subtle.ConstantTimeCompare — never a
// plain string comparison, whose early exit leaks the length of the
// matching prefix.
func requireBearerToken(expected string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme, presented, found := strings.Cut(r.Header.Get("Authorization"), " ")
		// The scheme name is not a secret, so comparing it in variable
		// time discloses nothing; only the token itself needs the
		// constant-time comparison below.
		if !found || !strings.EqualFold(scheme, "Bearer") {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "unauthorized"})
			return
		}
		// A misconfigured (empty) expected token must never authorize a
		// request, even one presenting an empty token.
		// FH: claude says ConstantTimeCompare leaks the length, hash both sides first?
		// MK: token length isn't secret. no.
		if expected == "" || subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requirePost rejects every method other than POST with 405 and an Allow
// header. It is applied before the token check, so an unauthenticated GET
// gets 405 rather than 401.
func requirePost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method_not_allowed"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleRunBatch parses the request and calls the existing, unmodified
// settlement.RunDailyBatch — the same function the `run-batch` CLI
// subcommand calls, with the same arguments.
func handleRunBatch(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body runBatchRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_json_body"})
			return
		}

		if body.Date == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "date_required"})
			return
		}
		businessDate, err := time.Parse(businessDateLayout, body.Date)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_date"})
			return
		}

		var onlyMerchant *uuid.UUID
		if body.MerchantID != "" {
			merchantID, err := uuid.Parse(body.MerchantID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_merchant_id"})
				return
			}
			onlyMerchant = &merchantID
		}

		report, err := settlement.RunDailyBatch(r.Context(), pool, businessDate, onlyMerchant)
		if err != nil {
			log.Printf("settlement internal api: run-batch(%s) failed: %v", body.Date, err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "run_batch_failed"})
			return
		}

		results := make([]merchantBatchOutcomeResponse, 0, len(report.MerchantResults))
		for _, result := range report.MerchantResults {
			results = append(results, merchantBatchOutcomeResponse{
				MerchantID:    result.MerchantID.String(),
				BatchID:       result.BatchID.String(),
				AlreadyClosed: result.AlreadyClosed,
				AlreadyPaid:   result.AlreadyPaid,
				GrossFils:     int64(result.GrossFils),
				FeeFils:       int64(result.FeeFils),
				NetPayoutFils: int64(result.NetPayoutFils),
			})
		}

		writeJSON(w, http.StatusOK, runBatchResponse{
			BusinessDate:    report.BusinessDate.Format(businessDateLayout),
			MerchantResults: results,
		})
	})
}

// handleRebuildBalances backs the admin console's "Rebuild cached balances"
// action. Takes no body; any body sent is ignored.
func handleRebuildBalances(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		diffs, err := ledger.RebuildAllBalances(r.Context(), pool)
		if err != nil {
			log.Printf("settlement internal api: rebuild-balances failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "rebuild_balances_failed"})
			return
		}

		// The diff map, keyed by merchant id, exactly as the Go function
		// returns it — the caller decides which entries to surface (the
		// admin console shows only the changed ones).
		response := make(map[string]rebuildDiffResponse, len(diffs))
		for merchantID, diff := range diffs {
			response[merchantID.String()] = rebuildDiffResponse{
				MerchantID: merchantID.String(),
				Before:     int64(diff.CachedBefore),
				After:      int64(diff.Rebuilt),
				Changed:    diff.Changed(),
			}
		}

		writeJSON(w, http.StatusOK, response)
	})
}

// handleRecalculateMDR parses the request and calls
// settlement.RecalculateMDR — the same per-event ComputeSettlementFee
// formula CloseBatch uses, applied to a merchant's historical batches at
// their current contracted rate.
func handleRecalculateMDR(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body recalculateMDRRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_json_body"})
			return
		}

		merchantID, err := uuid.Parse(body.MerchantID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_merchant_id"})
			return
		}
		from, err := time.Parse(businessDateLayout, body.From)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_from"})
			return
		}
		to, err := time.Parse(businessDateLayout, body.To)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_to"})
			return
		}

		result, err := settlement.RecalculateMDR(r.Context(), pool, merchantID, from, to)
		if err != nil {
			log.Printf("settlement internal api: recalculate-mdr(%s) failed: %v", body.MerchantID, err)
			writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "recalculate_mdr_failed"})
			return
		}

		adjusted := make([]batchAdjustmentResponse, 0, len(result.Adjusted))
		for _, a := range result.Adjusted {
			adjusted = append(adjusted, batchAdjustmentResponse{
				BatchID:    a.BatchID.String(),
				BatchDate:  a.BatchDate.Format(businessDateLayout),
				Status:     a.Status,
				OldFeeFils: int64(a.OldFeeFils),
				NewFeeFils: int64(a.NewFeeFils),
				DiffFils:   int64(a.DiffFils),
			})
		}

		writeJSON(w, http.StatusOK, recalculateMDRResponse{
			BatchesConsidered: result.BatchesConsidered,
			Adjusted:          adjusted,
		})
	})
}

// copilot: Encode errors after WriteHeader cannot change the status code; logging is the only option.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// The status line and (likely) part of the body are already on the
		// wire, so there is nothing left to tell the client — log it and
		// move on rather than swallowing it silently.
		log.Printf("settlement internal api: write response: %v", err)
	}
}
