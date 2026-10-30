# Bug 68 — `PGCONN_SETTLEMENT` silently replaces `DATABASE_URL`

**Severity:** Medium · **Area:** Ops · **Source:** CODE-016, FINDING C-40

## Where
- `apps/settlement/internal/config/config.go:72-74`

```go
if override := os.Getenv("PGCONN_SETTLEMENT"); override != "" {
    databaseURL = override
}
```

The comment above it, and the compose comment, say the opposite: unset means `DATABASE_URL` wins, and compose "doesn't set it". Compose does set `PGCONN_SETTLEMENT`.

## What's wrong
If both variables are present, the Go settlement process uses `PGCONN_SETTLEMENT` and never mentions the swap. API, reporting, and the seed job keep using `DATABASE_URL`. The two can point at different databases.

## Why
The override was added for a replica and documented as the fallback.

## What it breaks
Batches, payouts, and the admin rebuild/MDR calls write a different Postgres than the one the API reads. Balances and "batch closed" then disagree with captures, with no error at boot.

## Smallest fix
Log which variable was selected. In compose, set one URL. Fail boot if both are set and they differ, unless an explicit override flag is on.
