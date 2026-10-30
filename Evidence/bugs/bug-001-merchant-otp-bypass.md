# BUG-001 — Merchant Login Grants Full Access Without Entering OTP

## 1. Summary

`POST /v1/auth/login` checks the password, then sets `fp_sid` to a **pending** session (`authenticated = false`).

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authentication and sessions
- Affected Component: apps/api/src/auth/sessions.ts
- Reachability: Reachable via public POST /v1/auth/login
- Original Contributors / Sources: YA ARCHITECTURE, migration 0012, clue 'Login works without OTP'

## 3. Root Cause

Migration 0012 states every authenticating query must include `authenticated = true`. Migration 0058 replaced the direct `sessions` query with a view and dropped that predicate. The admin plane kept the check; the merchant plane lost it.

## 4. Affected Files and Functions

- `apps/api/src/auth/sessions.ts:78-103` — `lookupSession`
- `db/migrations/0058_live_sessions.sql:3-12` — `live_sessions` view
- `apps/api/src/routes/auth.ts:87-105` — pending cookie issued after password only
- Contrast: `apps/api/src/adminAuth/sessions.ts` still requires `authenticated = true`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`POST /v1/auth/login` checks the password, then sets `fp_sid` to a **pending** session (`authenticated = false`). Every protected merchant route resolves that cookie through `lookupSession`, which reads `live_sessions`. The view filters only `revoked_at IS NULL AND expires_at > now()`. Nothing checks `authenticated = true`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/auth/sessions.ts:78-103` — `lookupSession`
- `db/migrations/0058_live_sessions.sql:3-12` — `live_sessions` view
- `apps/api/src/routes/auth.ts:87-105` — pending cookie issued after password only
- Contrast: `apps/api/src/adminAuth/sessions.ts` still requires `authenticated = true`

Technical details:
`POST /v1/auth/login` checks the password, then sets `fp_sid` to a **pending** session (`authenticated = false`). Every protected merchant route resolves that cookie through `lookupSession`, which reads `live_sessions`. The view filters only `revoked_at IS NULL AND expires_at > now()`. Nothing checks `authenticated = true`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

The second factor protects nothing. With only a stolen password, an attacker calls `/login`, keeps the cookie, and has a full session for 10 minutes — including owner-only actions such as minting a live API key.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: YA ARCHITECTURE, migration 0012, clue 'Login works without OTP'. Legacy file: `bug-1-merchant-otp-bypass.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Add `AND authenticated = true` to `lookupSession` (or to the `live_sessions` view). Add a regression test that a pending cookie gets 401 on `/v1/auth/me`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-1-merchant-otp-bypass.md`

## 17. Evidence References

`apps/api/src/auth/sessions.ts`, `bug-1-merchant-otp-bypass.md`
