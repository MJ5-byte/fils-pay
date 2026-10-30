# BUG-049 — Duplicate settlement.paid Notifications Dispatched by Concurrent Triggers

## 1. Summary

Two processes pass `NOT EXISTS` before either commits.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/settlement/internal/settlement/payout_notify.go
- Reachability: Reachable on settlement batch payment
- Original Contributors / Sources: Incident 2026-08-21

## 3. Root Cause

Check-then-act without a unique constraint. Comment in daemon claims the NOT EXISTS guard makes it a no-op.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/payout_notify.go:33-89` — `SELECT … WHERE NOT EXISTS` then a separate `INSERT`
- `db/migrations/0009_outbox_events.sql` — no `UNIQUE (event_type, aggregate_id)`
- Daemon **and** CLI can both call this on the same tick (`daemon.go` comment even names the CLI overlap)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two processes pass `NOT EXISTS` before either commits. Both insert `settlement.paid`. Merchants get two "your payout is on the way" webhooks. Each delivery can also mint a disbursement row (Bug 41).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/payout_notify.go:33-89` — `SELECT … WHERE NOT EXISTS` then a separate `INSERT`
- `db/migrations/0009_outbox_events.sql` — no `UNIQUE (event_type, aggregate_id)`
- Daemon **and** CLI can both call this on the same tick (`daemon.go` comment even names the CLI overlap)

Technical details:
Two processes pass `NOT EXISTS` before either commits. Both insert `settlement.paid`. Merchants get two "your payout is on the way" webhooks. Each delivery can also mint a disbursement row (Bug 41).

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Duplicate payout messages. Downstream processors that are not idempotent double-pay.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Incident 2026-08-21. Legacy file: `bug-40-duplicate-payout-notifications.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`UNIQUE (event_type, aggregate_id)` + `INSERT … ON CONFLICT DO NOTHING` in one statement.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-40-duplicate-payout-notifications.md`

## 17. Evidence References

`apps/settlement/internal/settlement/payout_notify.go`, `bug-40-duplicate-payout-notifications.md`
