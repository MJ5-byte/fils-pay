# BUG-034 — Scheme Export Rounds Amounts While Ledger Truncates Creating Persistent Surplus

## 1. Summary

Two representations of the same line.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/settlement/scheme_export.go, batch.go
- Reachability: Reachable on scheme export file generation
- Original Contributors / Sources: Finance clue 'statement total always higher', ADR-0002

## 3. Root Cause

ADR-0002 option A was accepted and marked "implemented"; HANDOVER says YA did not get to the posting. MK replaced the 3dp column. The float BD column is what the scheme file uses.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/scheme_export.go:23-30` — `TruncateToSchemeAmount` vs `SchemeAmountBD`
- `apps/settlement/internal/settlement/batch.go:250-255` — inserts truncated fils **and** `float64(gross)/1000` into `NUMERIC(10,2)` (Postgres rounds half-up)
- ADR-0002 residue posting (`gross - truncated` → `scheme_rounding_residue`) is **not** in `CloseBatch`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two representations of the same line. When `gross % 10 >= 5`, `amount` (2dp BD) rounds **up** while `amount_fils` truncated **down**. Residue is never journaled, so the ledger cannot tie to the scheme file.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/scheme_export.go:23-30` — `TruncateToSchemeAmount` vs `SchemeAmountBD`
- `apps/settlement/internal/settlement/batch.go:250-255` — inserts truncated fils **and** `float64(gross)/1000` into `NUMERIC(10,2)` (Postgres rounds half-up)
- ADR-0002 residue posting (`gross - truncated` → `scheme_rounding_residue`) is **not** in `CloseBatch`

Technical details:
Two representations of the same line. When `gross % 10 >= 5`, `amount` (2dp BD) rounds **up** while `amount_fils` truncated **down**. Residue is never journaled, so the ledger cannot tie to the scheme file.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Every statement is a few fils high. March sweep (Bug 34) was a band-aid and posts the wrong residue anyway.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue 'statement total always higher', ADR-0002. Legacy file: `bug-21-scheme-export-rounding-always-over.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Store `amount` from the **truncated** fils (`truncated/1000` formatted to two decimals). Post `gross - truncated` to `scheme_rounding_residue` inside `CloseBatch` as ADR-0002 specifies.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-21-scheme-export-rounding-always-over.md`

## 17. Evidence References

`apps/settlement/internal/settlement/scheme_export.go, batch.go`, `bug-21-scheme-export-rounding-always-over.md`
