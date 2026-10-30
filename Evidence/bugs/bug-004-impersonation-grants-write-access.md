# BUG-004 — Admin Merchant Impersonation Grants Write Access

## 1. Summary

An impersonating super_admin has a full owner session: capture, void, API keys, webhooks, refunds-once-wired.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/auth/requireMerchantAuth.ts
- Reachability: Reachable via admin impersonation token
- Original Contributors / Sources: YA handover, ARCHITECTURE, ADMIN.md draft

## 3. Root Cause

Role mapping was widened "for support cases" and the handler does not re-check. HANDOVER's read-only promise is a comment, not a gate.

## 4. Affected Files and Functions

- `apps/api/src/admin/impersonation.ts:85-88, 132` — `super_admin` → merchant `owner`, `finance` → `finance`, `support` → `support`
- `apps/api/src/routes/transactions.ts` — capture/void only `requireMerchantAuth`, no extra role, no "if impersonating then deny writes"
- JSDoc on the lookup still says `merchantRole` is always `"support"`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

An impersonating super_admin has a full owner session: capture, void, API keys, webhooks, refunds-once-wired. Capture and void have no `requireMerchantRole` at all, so a real merchant `support` user can move money the same way, with no impersonation involved. Grants also stay valid after the admin is disabled: the grant lookup does not join `admin_users.status`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/impersonation.ts:85-88, 132` — `super_admin` → merchant `owner`, `finance` → `finance`, `support` → `support`
- `apps/api/src/routes/transactions.ts` — capture/void only `requireMerchantAuth`, no extra role, no "if impersonating then deny writes"
- JSDoc on the lookup still says `merchantRole` is always `"support"`

Technical details:
An impersonating super_admin has a full owner session: capture, void, API keys, webhooks, refunds-once-wired. Capture and void have no `requireMerchantRole` at all, so a real merchant `support` user can move money the same way, with no impersonation involved. Grants also stay valid after the admin is disabled: the grant lookup does not join `admin_users.status`.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Ops acting as a merchant can move that merchant's money with no merchant-user audit trail (only an impersonation grant).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: YA handover, ARCHITECTURE, ADMIN.md draft. Legacy file: `bug-47-impersonation-grants-write-access.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Force `merchantRole: "support"` for every admin. Deny capture/void/refunds/API-key writes when `admin_impersonation` is set.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-47-impersonation-grants-write-access.md`

## 17. Evidence References

`apps/api/src/auth/requireMerchantAuth.ts`, `bug-47-impersonation-grants-write-access.md`
