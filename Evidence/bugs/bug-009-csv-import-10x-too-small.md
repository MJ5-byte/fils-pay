# BUG-009 — Adjustment CSV Parser Treats BHD as 2-Decimal Currency Reducing Values by 10x

## 1. Summary

`4.75` becomes `475` fils (0.475 BD), not `4 750`.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Ledger and financial calculations
- Affected Component: apps/api/src/admin/adjustmentCsvParsing.ts
- Reachability: Reachable via admin adjustment CSV upload
- Original Contributors / Sources: Clue 'CSV 4.75 -> 0.475', commit 9567ea07, EVID-014

## 3. Root Cause

A cents-era helper (`decimals = 2`) is used for a 3-decimal currency. Agent files claim "1 BD = 100 cents" and "do not modify packages/money" — those are decoys. ADR-0001: 1 BD = 1000 fils, `parseBhdToFils` only.

## 4. Affected Files and Functions

- `apps/api/src/admin/adjustmentCsvParsing.ts:6-8` — `toFils(parseDecimalMinor(raw))`
- `apps/api/src/lib/decimal.ts:4-17` — `parseDecimalMinor(raw, decimals = 2)` pads/truncates the fraction to **2** places
- Correct parser: `packages/money` `parseBhdToFils` (ADR-0001)

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`4.75` becomes `475` fils (0.475 BD), not `4 750`. `4.755` is cut to two fraction digits (`75`) and then read as cents: `475` fils (0.475 BD), not 4.750 BD. The finance note's "ledger shows 4.750" does not match this parser. Locked tests encode the wrong expectation (`475`).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/adjustmentCsvParsing.ts:6-8` — `toFils(parseDecimalMinor(raw))`
- `apps/api/src/lib/decimal.ts:4-17` — `parseDecimalMinor(raw, decimals = 2)` pads/truncates the fraction to **2** places
- Correct parser: `packages/money` `parseBhdToFils` (ADR-0001)

Technical details:
`4.75` becomes `475` fils (0.475 BD), not `4 750`. `4.755` is cut to two fraction digits (`75`) and then read as cents: `475` fils (0.475 BD), not 4.750 BD. The finance note's "ledger shows 4.750" does not match this parser. Locked tests encode the wrong expectation (`475`).

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Every manual finance CSV under-credits merchants by 10× and silently drops the third decimal.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'CSV 4.75 -> 0.475', commit 9567ea07, EVID-014. Legacy file: `bug-19-csv-import-10x-too-small.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`return parseBhdToFils(raw)` (with `allowNegative` if needed). Do not use `parseDecimalMinor` for BHD.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-19-csv-import-10x-too-small.md`

## 17. Evidence References

`apps/api/src/admin/adjustmentCsvParsing.ts`, `bug-19-csv-import-10x-too-small.md`
