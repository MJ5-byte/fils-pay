# BUG-084 — Recent Ledger Activity Query Includes Entire Exclusive End Date

## 1. Summary

The shared analytics parser defines to as exclusive, but the ledger activity SQL compares Bahrain dates with inclusive BETWEEN.

## 2. Classification

- Severity: Low
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/analytics/query.ts
- Reachability: Reachable on analytics ledger activity queries
- Original Contributors / Sources: Blind spot investigation BUG-012

## 3. Root Cause

The shared analytics parser defines to as exclusive, but the ledger activity SQL compares Bahrain dates with inclusive BETWEEN.

## 4. Affected Files and Functions

`apps/api/src/routes/analytics.ts:62-78,108-114`; `apps/api/src/analytics/query.ts:298-309`.

## 5. Expected Behavior

For from=2026-09-01 and to=2026-09-02, only activity on September 1 Bahrain time is returned.

## 6. Actual Behavior

Entries on September 2 are also returned. Adjacent analytics windows overlap by one whole day; from=to can return a day of records instead of an empty interval.

## 7. Trigger Conditions

An authenticated merchant requests recent-ledger-activity with entries on the to date.

## 8. Technical Evidence

parseDateRange is shared by all analytics routes and passes to unchanged. SQL: `(occurred_at AT TIME ZONE 'Asia/Bahrain')::date BETWEEN $2::date AND $3::date`; volumes and payout trends use `< $3` instead.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Date-filtered ledger views include out-of-window transactions and disagree with other analytics widgets. Tenant predicate is correct; no cross-tenant disclosure claimed.

## 11. Safe Reproduction

Analytics tests must include an entry exactly at the Bahrain start of the to date and later that date; both should be excluded. Existing route test coverage is reviewed separately in the summary.

## 12. Related Findings

No matching CODE/FINDING/NEW or runtime artifact found. Distinct from CODE-026 scheduler date selection and CODE-036 script month bounds.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Use half-open Bahrain instant bounds or inclusive lower/exclusive upper date comparisons consistently. No fix implemented.

## 15. Remaining Questions and Limitations

Read-only query result defect; no actual finance export or runtime request produced in this investigation.

## 16. Original Reports Merged

`bug-12-ledger-activity-includes-exclusive-end-date.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
