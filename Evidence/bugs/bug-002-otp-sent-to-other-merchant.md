# BUG-002 — OTP and Session Bound to Different Merchant Allowing Cross-Tenant Takeover

## 1. Summary

Password verification uses the requested merchant.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/routes/auth.ts
- Reachability: Reachable via public auth routes
- Original Contributors / Sources: Clue 'OTP sent to another merchant'

## 3. Root Cause

A global email lookup after a tenant-scoped password check. Email is unique per merchant, not globally.

## 4. Affected Files and Functions

- `apps/api/src/routes/auth.ts:60-97` — password is checked against `(merchantId, email)`, then discarded
- `apps/api/src/auth/users.ts:10-23` — `findOtpRecipient`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Password verification uses the requested merchant. OTP and the pending session then use `findOtpRecipient(email)`, which picks **any** active merchant user with that email (`LIMIT 1`, no `merchant_id`, no `ORDER BY`). Challenge, session, and the emailed code all go to `recipient.id`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/auth.ts:60-97` — password is checked against `(merchantId, email)`, then discarded
- `apps/api/src/auth/users.ts:10-23` — `findOtpRecipient`

Technical details:
Password verification uses the requested merchant. OTP and the pending session then use `findOtpRecipient(email)`, which picks **any** active merchant user with that email (`LIMIT 1`, no `merchant_id`, no `ORDER BY`). Challenge, session, and the emailed code all go to `recipient.id`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

- OTP is sent to another merchant's inbox if the same email exists there.
- Combined with Bug 1, an attacker who knows **their own** password on merchant B can operate as the victim on merchant A.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'OTP sent to another merchant'. Legacy file: `bug-2-otp-sent-to-other-merchant.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Use the `user` row from the login query for `issueChallenge`, `createPendingSession`, and `sendOtpCode`. Remove `findOtpRecipient`. Test two merchants sharing an email.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-2-otp-sent-to-other-merchant.md`

## 17. Evidence References

`apps/api/src/routes/auth.ts`, `bug-2-otp-sent-to-other-merchant.md`
