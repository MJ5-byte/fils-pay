# BUG-046 — Inbound Acquirer HMAC Verification Reserializes Parsed JSON Object

## 1. Summary

Verifier does `HMAC(timestamp + "." + JSON.stringify(parsedObject))`.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/inboundVerify.ts
- Reachability: Reachable on inbound acquirer callbacks
- Original Contributors / Sources: Support FP-240

## 3. Root Cause

Sign-the-object instead of sign-the-bytes, copied from the outbound bug in reverse.

## 4. Affected Files and Functions

- `apps/api/src/webhooks/inboundVerify.ts:40-66`
- `apps/api/src/routes/acquirerCallbacks.ts`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Verifier does `HMAC(timestamp + "." + JSON.stringify(parsedObject))`. The acquirer signed the raw body. Key order, spacing, and number formatting differ after Fastify parses JSON. Timestamp is parsed and **never** checked for freshness. Compare uses `Buffer.compare` on decoded bytes, not `timingSafeEqualHex`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/inboundVerify.ts:40-66`
- `apps/api/src/routes/acquirerCallbacks.ts`

Technical details:
Verifier does `HMAC(timestamp + "." + JSON.stringify(parsedObject))`. The acquirer signed the raw body. Key order, spacing, and number formatting differ after Fastify parses JSON. Timestamp is parsed and **never** checked for freshness. Compare uses `Buffer.compare` on decoded bytes, not `timingSafeEqualHex`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Legitimate signed callbacks fail (so ops turns the check off — Bug 38). Replays of old callbacks succeed when a signature is present.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support FP-240. Legacy file: `bug-37-inbound-callback-hmac-reserialized.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

HMAC `${timestamp}.${rawBody}`. Enforce a max age on `t=`. Use `timingSafeEqualHex`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-37-inbound-callback-hmac-reserialized.md`

## 17. Evidence References

`apps/api/src/webhooks/inboundVerify.ts`, `bug-37-inbound-callback-hmac-reserialized.md`
