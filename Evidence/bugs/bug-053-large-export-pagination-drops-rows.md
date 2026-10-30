# BUG-053 — Transaction CSV Export Pagination Drops Rows Sharing Identical Timestamp

## 1. Summary

All but one row with the same `occurred_at` vanish on the next page.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Reporting and analytics
- Affected Component: apps/api/src/transactions/exportCsv.ts
- Reachability: Reachable on exports exceeding 1,000 rows with concurrent transactions
- Original Contributors / Sources: Support ticket on missing CSV export rows

## 3. Root Cause

Cursor forgot the unique tiebreaker.

## 4. Affected Files and Functions

- `apps/api/src/transactions/exportCsv.ts:66-84` — cursor is `occurred_at > $cursor` only
- List query correctly uses `(occurred_at, id)` composite
- HTTP route currently loads the full set into memory (`buildTransactionsExportCsv`) — OOM at scale; the streaming helper is still wrong if wired

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

All but one row with the same `occurred_at` vanish on the next page. Agent files say loading everything is intentional.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/transactions/exportCsv.ts:66-84` — cursor is `occurred_at > $cursor` only
- List query correctly uses `(occurred_at, id)` composite
- HTTP route currently loads the full set into memory (`buildTransactionsExportCsv`) — OOM at scale; the streaming helper is still wrong if wired

Technical details:
All but one row with the same `occurred_at` vanish on the next page. Agent files say loading everything is intentional.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Finance exports silently lose captures that share a millisecond (batch close, payment-link double-capture, etc.). Reconciliation vs scheme is short.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support ticket on missing CSV export rows. Legacy file: `bug-54-large-export-pagination-drops-rows.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`(occurred_at, id) > ($cursorTs, $cursorId)`. Stream the HTTP route; do not hold the full result.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-54-large-export-pagination-drops-rows.md`

## 17. Evidence References

`apps/api/src/transactions/exportCsv.ts`, `bug-54-large-export-pagination-drops-rows.md`
