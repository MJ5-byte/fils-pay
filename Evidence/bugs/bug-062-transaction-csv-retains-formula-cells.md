# BUG-062 — Transaction CSV Export Retains Formula Prefixes Enabling Spreadsheet Injection

## 1. Summary

CSV escaping handles commas, quotes and linefeeds but does not neutralize formula prefixes in a caller-controlled transaction reference.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/api/src/transactions/exportCsv.ts
- Reachability: Reachable on CSV export containing user-controlled references
- Original Contributors / Sources: Blind spot investigation BUG-016

## 3. Root Cause

CSV escaping handles commas, quotes and linefeeds but does not neutralize formula prefixes in a caller-controlled transaction reference.

## 4. Affected Files and Functions

`apps/api/src/transactions/exportCsv.ts:13-29,34-53`; `apps/api/src/routes/transactions.ts:68-83,152-173`; `apps/api/src/payments/authorize.ts:102-109`; `apps/api/src/transactions/exportCsv.test.ts:179-195`.

## 5. Expected Behavior

A reference remains literal data when the downloadable transaction CSV is opened in a spreadsheet.

## 6. Actual Behavior

A benign reference '=1+1' is stored unchanged and emitted unchanged in the reference cell. A formula-aware spreadsheet importer can evaluate it as a formula rather than display the original text. Quoting alone would also not establish literal-cell semantics.

## 7. Trigger Conditions

An integration supplies a formula-prefixed reference and an operator opens the exported CSV in a formula-evaluating spreadsheet. All data remains scoped to that merchant.

## 8. Technical Evidence

Authorize stores input.reference directly. toCsvRow passes it to csvEscape, which returns '=1+1' unchanged because it contains no delimiter/quote/newline. GET /v1/transactions/export sends the result as a downloadable CSV.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Spreadsheet data integrity is compromised for untrusted reference values; more consequential effects depend on the importing application's formula support and security settings. No remote code execution or exfiltration is claimed.

## 11. Safe Reproduction

The export test checks CSV punctuation escaping only and explicitly has no formula-prefix case. Future case: '=1+1', plus other supported formula prefixes, must remain literal under the chosen spreadsheet export contract.

## 12. Related Findings

Earlier investigations noted buffered exports but did not establish formula-cell injection. No matching runtime artifact or existing CODE/FINDING/NEW found.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Apply an explicit spreadsheet-safe literal-cell policy to untrusted text, or export a format with explicit text types. Preserve a documented policy for non-spreadsheet CSV consumers. No fix implemented.

## 15. Remaining Questions and Limitations

Formula execution is consumer-dependent; only the unsanitized export path is statically confirmed. No spreadsheet or application was executed.

## 16. Original Reports Merged

`bug-16-transaction-csv-retains-formula-cells.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
