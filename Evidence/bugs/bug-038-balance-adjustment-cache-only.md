# BUG-038 — Admin Balance Adjustment Modifies Cache and Audit Only Bypassing Ledger

## 1. Summary

The production route changes `merchant_balances.cached_payable_fils` and writes an audit row.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Admin console and controls
- Affected Component: apps/api/src/routes/adminBalanceAdjustments.ts
- Reachability: Reachable via Admin Console Adjust Balance
- Original Contributors / Sources: FP-203 clue, ADR-0004, ADR-0006

## 3. Root Cause

Cache was treated as source of truth because the button already diverged (Bug 22).

## 4. Affected Files and Functions

- `apps/api/src/routes/adminBalanceAdjustments.ts` — calls `applyBalanceCorrection`
- `apps/api/src/admin/balanceAdjustments.ts` — cache + audit UPDATE; a journaled variant exists in the same file and is not routed

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The production route changes `merchant_balances.cached_payable_fils` and writes an audit row. No `ledger_entries`. The next real rebuild (CLI, or a fixed button) overwrites the adjustment. The journaled helper is dead code.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/adminBalanceAdjustments.ts` — calls `applyBalanceCorrection`
- `apps/api/src/admin/balanceAdjustments.ts` — cache + audit UPDATE; a journaled variant exists in the same file and is not routed

Technical details:
The production route changes `merchant_balances.cached_payable_fils` and writes an audit row. No `ledger_entries`. The next real rebuild (CLI, or a fixed button) overwrites the adjustment. The journaled helper is dead code.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

"Corrections" vanish. Audit says money moved; the ledger says it did not.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: FP-203 clue, ADR-0004, ADR-0006. Legacy file: `bug-23-balance-adjustment-cache-only.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Route POST to `adjustMerchantBalanceJournaled`. Rebuild always from the ledger.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-23-balance-adjustment-cache-only.md`

## 17. Evidence References

`apps/api/src/routes/adminBalanceAdjustments.ts`, `bug-23-balance-adjustment-cache-only.md`
