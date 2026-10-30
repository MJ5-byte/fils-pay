# BUG-033 — March Residue Sweep Script Is Non-Idempotent and Uses UTC Month Window

## 1. Summary

Each run posts a new balanced group.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: scripts/reconcile_march.ts
- Reachability: Reachable on manual operator execution
- Original Contributors / Sources: Finance clue 'gap doubled on staging', ADR-0002, ADR-0003

## 3. Root Cause

A one-off was left in the tree and documented as safe.

## 4. Affected Files and Functions

- `scripts/reconcile_march.ts:16-18, 27-30, 71-81` — `randomUUID()` per merchant per run; comment claims re-run is safe
- Residue = `captured_fils % 10` over a **UTC** month, not scheme-line truncation vs rounding (Bug 21)
- No `WHERE NOT EXISTS` / deterministic `entry_group_id`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Each run posts a new balanced group. Two runs double the "fix." The amount is not the scheme residue ADR-0002 defined. The calendar is UTC, not Asia/Bahrain (ADR-0003).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `scripts/reconcile_march.ts:16-18, 27-30, 71-81` — `randomUUID()` per merchant per run; comment claims re-run is safe
- Residue = `captured_fils % 10` over a **UTC** month, not scheme-line truncation vs rounding (Bug 21)
- No `WHERE NOT EXISTS` / deterministic `entry_group_id`

Technical details:
Each run posts a new balanced group. Two runs double the "fix." The amount is not the scheme residue ADR-0002 defined. The calendar is UTC, not Asia/Bahrain (ADR-0003).

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Re-running (or running on production after staging) fabricates ledger credits. Nobody can tell from the log file how many times it ran (one timestamp).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Finance clue 'gap doubled on staging', ADR-0002, ADR-0003. Legacy file: `bug-34-march-sweep-not-idempotent.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Deterministic `entry_group_id` + `INSERT … WHERE NOT EXISTS`. Do not run it at all once CloseBatch posts residue (Bug 21). If it must exist, use Bahrain March bounds and residue = `gross - truncated` per export line.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-34-march-sweep-not-idempotent.md`

## 17. Evidence References

`scripts/reconcile_march.ts`, `bug-34-march-sweep-not-idempotent.md`
