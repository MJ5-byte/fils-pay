// Package config loads apps/settlement's environment-variable
// configuration, mirroring apps/api's loadConfig shape. It reads
// DATABASE_URL, the same environment variable apps/api reads — every
// service in this repo connects to Postgres via DATABASE_URL.
//
// SETTLEMENT_TIMEZONE is deliberately NOT a config field. The business-day
// timezone is a Go constant (internal/settlement/window.go), not an
// environment-configurable value.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is apps/settlement's full runtime configuration.
//
// All fields are read once at boot; changing an environment variable needs a
// restart of the process.
type Config struct {
	DatabaseURL string
	// PGPoolMaxConns stays small — this worker processes merchants
	// sequentially (never concurrently), so it never needs more than a
	// couple of concurrent connections at once regardless of the
	// configured max.
	PGPoolMaxConns int32
	// DaemonRunDelayMinutes is the buffer after Asia/Bahrain midnight
	// before a day is batched (lets any last straggling writes for the
	// day that just ended settle before the daemon scans it).
	DaemonRunDelayMinutes int
	// DaemonPollInterval is how often the daemon wakes to check whether
	// it's time to run the next scheduled batching pass.
	DaemonPollInterval time.Duration
	// InternalPort is the TCP port internal/internalapi's server binds,
	// serving the two admin-triggerable operations apps/api's admin plane
	// invokes. Reachable only inside the deployment's own network.
	InternalPort int
	// InternalToken is the shared secret every internal HTTP request must
	// present as `Authorization: Bearer <token>`. Only required by the
	// `daemon` subcommand, which is the only one that starts the internal
	// HTTP server — see RequireInternalToken below. Load itself does not
	// fail on this being unset, so the one-shot CLI subcommands
	// (`run-batch`, `rebuild-balances`, `export-scheme-file`) keep working
	// standalone without needing to know about an HTTP server they never
	// start.
	InternalToken string
}

// Load reads Config from the process environment. Fails fast (returns an
// error main.go treats as a fatal boot error) if DATABASE_URL is unset,
// mirroring apps/api's crash-rather-than-serve-half-configured posture.
// SETTLEMENT_INTERNAL_TOKEN is read but not required here — see
// RequireInternalToken, called only by the subcommand that actually needs it.
func Load() (Config, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return Config{}, fmt.Errorf("config: DATABASE_URL environment variable is not set")
	}

	// PGCONN_SETTLEMENT optionally overrides DATABASE_URL for a deployment
	// that routes this worker's batch/export queries through a dedicated
	// settlement Postgres role or read replica, kept separate from the
	// pool apps/api's request path uses so a long-running batch close can't
	// starve it. Unset in the common case — most deployments share one
	// Postgres instance across every service, so DATABASE_URL alone is
	// sufficient and this worker falls back to it exactly like every other
	// service does.
	// MK (b64cd3c): replica routing for batch close. compose doesn't set it so DATABASE_URL wins.
	// am: compose DOES set PGCONN_SETTLEMENT? i added it in june. or that was .env.docker
	if override := os.Getenv("PGCONN_SETTLEMENT"); override != "" {
		databaseURL = override
	}

	// Read here, required only by `daemon` (see RequireInternalToken).
	internalToken := os.Getenv("SETTLEMENT_INTERNAL_TOKEN")

	// FH: 5 conns x 3 services > pg max_connections? no, that's 15 of 100. fine
	maxConns, err := parseIntEnv("SETTLEMENT_PG_POOL_MAX_CONNS", 5)
	if err != nil {
		return Config{}, err
	}

	// MK: 15 min after Bahrain midnight is the intent. whether runIfDue really computes Bahrain midnight, ask FH
	runDelay, err := parseIntEnv("SETTLEMENT_DAEMON_RUN_DELAY_MINUTES", 15)
	if err != nil {
		return Config{}, err
	}

	pollIntervalSeconds, err := parseIntEnv("SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS", 60)
	if err != nil {
		return Config{}, err
	}

	internalPort, err := parseIntEnv("SETTLEMENT_INTERNAL_PORT", 8091)
	if err != nil {
		return Config{}, err
	}

	return Config{
		DatabaseURL:           databaseURL,
		PGPoolMaxConns:        int32(maxConns),
		DaemonRunDelayMinutes: runDelay,
		DaemonPollInterval:    time.Duration(pollIntervalSeconds) * time.Second,
		InternalPort:          internalPort,
		InternalToken:         internalToken,
	}, nil
}

// RequireInternalToken validates that InternalToken is set, returning an
// error suitable for a fatal boot failure. Call this only from the
// subcommand that actually starts the internal HTTP server (`daemon`) —
// the one-shot CLI subcommands never call it and so never need this
// unrelated secret configured just to run a manual batch or export.
func (c Config) RequireInternalToken() error {
	if c.InternalToken == "" {
		return fmt.Errorf("config: SETTLEMENT_INTERNAL_TOKEN environment variable is not set")
	}
	return nil
}

func parseIntEnv(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("config: expected an integer for %s, got %q: %w", name, raw, err)
	}
	return parsed, nil
}
