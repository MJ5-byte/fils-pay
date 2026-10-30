# BUG-017 — Suspending a Merchant Does Not Revoke Active Session Tokens or API Keys

## 1. Summary

A session issued while the merchant was active, and any API key that has not been revoked, keep working after `merchants.status` moves to suspended or closed.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authentication and sessions
- Affected Component: apps/api/src/auth/sessions.ts, apps/api/src/auth/middleware.ts
- Reachability: Reachable by any suspended merchant with existing token
- Original Contributors / Sources: AI code audit, CODE-030

## 3. Root Cause

The status predicate was added to the login query and not to the two lookups every later request uses.

## 4. Affected Files and Functions

- Login is the only check: `apps/api/src/routes/auth.ts:60-64` requires `m.status = 'active'`
- `apps/api/src/auth/sessions.ts:89-93` — `lookupSession` joins `merchant_users` and does not look at `merchants.status`
- `apps/api/src/apiKeys/verify.ts:16-20` — `revoked_at IS NULL` only. `revoke_after` (migration 0056) is never read. Authorize checks `onboarding_status = 'approved'`; capture and void do not.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A session issued while the merchant was active, and any API key that has not been revoked, keep working after `merchants.status` moves to suspended or closed. Bug 44 is the same hole for rotation: the old key is a second credential that also ignores status.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- Login is the only check: `apps/api/src/routes/auth.ts:60-64` requires `m.status = 'active'`
- `apps/api/src/auth/sessions.ts:89-93` — `lookupSession` joins `merchant_users` and does not look at `merchants.status`
- `apps/api/src/apiKeys/verify.ts:16-20` — `revoked_at IS NULL` only. `revoke_after` (migration 0056) is never read. Authorize checks `onboarding_status = 'approved'`; capture and void do not.

Technical details:
A session issued while the merchant was active, and any API key that has not been revoked, keep working after `merchants.status` moves to suspended or closed. Bug 44 is the same hole for rotation: the old key is a second credential that also ignores status.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Suspending a merchant does not stop captures, voids, exports, or webhook changes for up to the session TTL (12 h) and indefinitely for API keys.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit, CODE-030. Legacy file: `bug-66-suspended-merchant-credentials-keep-working.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Join `merchants` in `lookupSession` and `verifyApiKey` and reject anything other than `active`. Enforce `revoke_after` in `verifyApiKey`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-66-suspended-merchant-credentials-keep-working.md`

## 17. Evidence References

`apps/api/src/auth/sessions.ts, apps/api/src/auth/middleware.ts`, `bug-66-suspended-merchant-credentials-keep-working.md`
