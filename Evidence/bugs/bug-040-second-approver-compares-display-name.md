# BUG-040 — Two-Person Rule Credit Approval Compares Display Name Instead of User ID

## 1. Summary

Two different admins named "Fatima" cannot approve each other's credits.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/credits.ts
- Reachability: Reachable on credit approval
- Original Contributors / Sources: YA handover, code audit

## 3. Root Cause

Matched to "the audit log format" (decoy JSDoc).

## 4. Affected Files and Functions

- `apps/api/src/admin/creditApproval.ts:10-13`

```ts
if (approver.displayName === requester.displayName)
```

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two different admins named "Fatima" cannot approve each other's credits. One person with two accounts and different display names **can**. HANDOVER's invariant is the opposite of the code.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/creditApproval.ts:10-13`

```ts
if (approver.displayName === requester.displayName)
```

Technical details:
Two different admins named "Fatima" cannot approve each other's credits. One person with two accounts and different display names **can**. HANDOVER's invariant is the opposite of the code.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Maker-checker is not maker-checker. Credits above threshold can be self-approved.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: YA handover, code audit. Legacy file: `bug-45-second-approver-compares-display-name.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Compare `adminUserId` only.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-45-second-approver-compares-display-name.md`

## 17. Evidence References

`apps/api/src/admin/credits.ts`, `bug-45-second-approver-compares-display-name.md`
