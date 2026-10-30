# BUG-045 — Webhook HMAC Computed Over Canonical JSON While Wire Body Is Stringified

## 1. Summary

Merchants who verify the raw HTTP body against `t=,v1=` get a mismatch even when the secret is correct.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/sign.ts, dispatcher.ts
- Reachability: Reachable on all outbound webhook deliveries
- Original Contributors / Sources: Support FP-240, YA handover branch ya/sign-raw

## 3. Root Cause

Canonical JSON was used for idempotency-style stability; the body was never switched to that string.

## 4. Affected Files and Functions

- `apps/api/src/webhooks/sign.ts:31-38` — HMAC over `canonicalJson(payload)` (sorted keys)
- `apps/api/src/webhooks/dispatcher.ts:158-172` — POST body is `JSON.stringify(row.payload)` (insertion order from Postgres/JS)
- Same split in `apps/api/src/webhooks/testSend.ts`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Merchants who verify the raw HTTP body against `t=,v1=` get a mismatch even when the secret is correct. YA's unmerged `ya/sign-raw` was the fix: sign the exact bytes that `transport` sends.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/sign.ts:31-38` — HMAC over `canonicalJson(payload)` (sorted keys)
- `apps/api/src/webhooks/dispatcher.ts:158-172` — POST body is `JSON.stringify(row.payload)` (insertion order from Postgres/JS)
- Same split in `apps/api/src/webhooks/testSend.ts`

Technical details:
Merchants who verify the raw HTTP body against `t=,v1=` get a mismatch even when the secret is correct. YA's unmerged `ya/sign-raw` was the fix: sign the exact bytes that `transport` sends.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Shops reject genuine webhooks. Retries look randomly invalid. FP-300 "the shop gets the right webhook" cannot pass.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support FP-240, YA handover branch ya/sign-raw. Legacy file: `bug-36-webhook-signature-mismatch.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`const body = canonicalJson(row.payload)` (or `JSON.stringify` once); HMAC that string; send that string. Do not re-serialize.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-36-webhook-signature-mismatch.md`

## 17. Evidence References

`apps/api/src/webhooks/sign.ts, dispatcher.ts`, `bug-36-webhook-signature-mismatch.md`
