# BUG-080 — PGCONN_SETTLEMENT Environment Variable Silently Overrides DATABASE_URL

## 1. Summary

If both variables are present, the Go settlement process uses `PGCONN_SETTLEMENT` and never mentions the swap.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Infrastructure and configuration
- Affected Component: apps/settlement/internal/config/config.go
- Reachability: Reachable during settlement service startup
- Original Contributors / Sources: AI code audit

## 3. Root Cause

The override was added for a replica and documented as the fallback.

## 4. Affected Files and Functions

- `apps/settlement/internal/config/config.go:72-74`

```go
if override := os.Getenv("PGCONN_SETTLEMENT"); override != "" {
    databaseURL = override
}
```

The comment above it, and the compose comment, say the opposite: unset means `DATABASE_URL` wins, and compose "doesn't set it". Compose does set `PGCONN_SETTLEMENT`.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

If both variables are present, the Go settlement process uses `PGCONN_SETTLEMENT` and never mentions the swap. API, reporting, and the seed job keep using `DATABASE_URL`. The two can point at different databases.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/config/config.go:72-74`

```go
if override := os.Getenv("PGCONN_SETTLEMENT"); override != "" {
    databaseURL = override
}
```

The comment above it, and the compose comment, say the opposite: unset means `DATABASE_URL` wins, and compose "doesn't set it". Compose does set `PGCONN_SETTLEMENT`.

Technical details:
If both variables are present, the Go settlement process uses `PGCONN_SETTLEMENT` and never mentions the swap. API, reporting, and the seed job keep using `DATABASE_URL`. The two can point at different databases.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Batches, payouts, and the admin rebuild/MDR calls write a different Postgres than the one the API reads. Balances and "batch closed" then disagree with captures, with no error at boot.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-68-pgconn-settlement-overrides-database-url.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Log which variable was selected. In compose, set one URL. Fail boot if both are set and they differ, unless an explicit override flag is on.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-68-pgconn-settlement-overrides-database-url.md`

## 17. Evidence References

`apps/settlement/internal/config/config.go`, `bug-68-pgconn-settlement-overrides-database-url.md`
