# BUG-015 — OTP Attempt Limit Is Racy and Resend Resets Guess Budget

## 1. Summary

1.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authentication and sessions
- Affected Component: apps/api/src/auth/otp.ts, apps/api/src/routes/auth.ts
- Reachability: Reachable via public auth endpoints
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Check-then-increment without a row lock; new challenge row per resend with no copied counter.

## 4. Affected Files and Functions

- `apps/api/src/routes/auth.ts:135-168` — verify: read `attempt_count`, then a separate UPDATE
- `apps/api/src/routes/adminAuth.ts:126-159` — same pattern (comment says `FOR UPDATE`; the SELECT does not)
- `apps/api/src/routes/auth.ts:194-228` — resend comment says attempts are inherited; `issueChallenge` inserts a new row with default `attempt_count = 0`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

1. The max-attempts check is not atomic. Concurrent `/otp/verify` requests all see `attempt_count = 0` and each get a guess.
2. Resend consumes the old challenge and inserts a new one. Attempts start at zero every 30 seconds.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/auth.ts:135-168` — verify: read `attempt_count`, then a separate UPDATE
- `apps/api/src/routes/adminAuth.ts:126-159` — same pattern (comment says `FOR UPDATE`; the SELECT does not)
- `apps/api/src/routes/auth.ts:194-228` — resend comment says attempts are inherited; `issueChallenge` inserts a new row with default `attempt_count = 0`

Technical details:
1. The max-attempts check is not atomic. Concurrent `/otp/verify` requests all see `attempt_count = 0` and each get a guess.
2. Resend consumes the old challenge and inserts a new one. Attempts start at zero every 30 seconds.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Online brute force of a 6-digit code (worse with Bug 3). `max_attempts` (default 5) is not an actual limit.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-4-otp-attempt-limit-race-and-resend-reset.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`SELECT … FOR UPDATE` (or a single `UPDATE … WHERE attempt_count < max_attempts RETURNING …`). Pass the previous `attempt_count` into `issueChallenge` on resend.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-4-otp-attempt-limit-race-and-resend-reset.md`

## 17. Evidence References

`apps/api/src/auth/otp.ts, apps/api/src/routes/auth.ts`, `bug-4-otp-attempt-limit-race-and-resend-reset.md`
