# BUG-082 — Settlement Progress Bar Divides Fils by 10,000 Instead of 1,000 Distorting Ratio

## 1. Summary

`grossFils / 10000` is ten times too small for a BD amount, and the result is then used as a width percentage.

## 2. Classification

- Severity: Low
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/web/src/pages/settlement/SettlementProgressBar.tsx
- Reachability: Reachable on settlement progress visual display
- Original Contributors / Sources: AI code audit

## 3. Root Cause

A progress calculation was pointed at the gross amount with a cents-sized divisor.

## 4. Affected Files and Functions

- `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx:84-91`

```ts
const displayProgress = parseFloat((batch.grossFils / 10000).toFixed(2));
// ...
width: `${Math.min(displayProgress, 100)}%`
```

1 BD = 1000 fils (ADR-0001). The bar is only rendered when `batch.status === "closed"`.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`grossFils / 10000` is ten times too small for a BD amount, and the result is then used as a width percentage. A batch of 500 000 fils (500 BD) draws a 50% bar. A batch of 1 000 000 fils or more draws 100%. `parseFloat` does not change that. The amounts in the definition list on the same page go through `formatBhd` and are not affected.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx:84-91`

```ts
const displayProgress = parseFloat((batch.grossFils / 10000).toFixed(2));
// ...
width: `${Math.min(displayProgress, 100)}%`
```

1 BD = 1000 fils (ADR-0001). The bar is only rendered when `batch.status === "closed"`.

Technical details:
`grossFils / 10000` is ten times too small for a BD amount, and the result is then used as a width percentage. A batch of 500 000 fils (500 BD) draws a 50% bar. A batch of 1 000 000 fils or more draws 100%. `parseFloat` does not change that. The amounts in the definition list on the same page go through `formatBhd` and are not affected.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

The closed-batch page shows a bar that is not a progress measure. It saturates for any batch over 1 000 BD.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-72-settlement-progress-divides-fils-by-10000.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Remove the bar, or bind it to a real ratio (for example paid vs closed) computed in integer fils. Do not divide by 10 000.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-72-settlement-progress-divides-fils-by-10000.md`

## 17. Evidence References

`apps/web/src/pages/settlement/SettlementProgressBar.tsx`, `bug-72-settlement-progress-divides-fils-by-10000.md`
