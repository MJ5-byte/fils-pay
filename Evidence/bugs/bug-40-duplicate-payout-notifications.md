# Bug 40 — Duplicate `settlement.paid` notifications (INCIDENT 2026-08-21)

**Severity:** High · **Area:** Payouts · **Clue:** Incident 2026-08-21 — *"Two processes checked at the same time, and both thought they were first."*

## Where
- `apps/settlement/internal/settlement/payout_notify.go:33-89` — `SELECT … WHERE NOT EXISTS` then a separate `INSERT`
- `db/migrations/0009_outbox_events.sql` — no `UNIQUE (event_type, aggregate_id)`
- Daemon **and** CLI can both call this on the same tick (`daemon.go` comment even names the CLI overlap)

## What's wrong
Two processes pass `NOT EXISTS` before either commits. Both insert `settlement.paid`. Merchants get two "your payout is on the way" webhooks. Each delivery can also mint a disbursement row (Bug 41).

## Why
Check-then-act without a unique constraint. Comment in daemon claims the NOT EXISTS guard makes it a no-op.

## What it breaks
Duplicate payout messages. Downstream processors that are not idempotent double-pay.

## Smallest fix
`UNIQUE (event_type, aggregate_id)` + `INSERT … ON CONFLICT DO NOTHING` in one statement.
