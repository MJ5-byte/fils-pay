# BUG-047 — Acquirer Callbacks Accepted Unsigned by Default in Configuration

## 1. Summary

Anyone who can reach the callback URL can attach `confirmed_fraud` / `cleared` notes (and arbitrary `outcome` strings) to any transaction UUID..

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Webhooks
- Affected Component: apps/api/src/config.ts, apps/api/src/webhooks/inboundVerify.ts
- Reachability: Reachable via POST /v1/acquirer-callbacks
- Original Contributors / Sources: ARCHITECTURE, code audit

## 3. Root Cause

A "dev convenience" default was left for production. Combined with Bug 37, requiring signatures would have broken real callbacks, so the flag stayed off.

## 4. Affected Files and Functions

- `apps/api/src/config.ts` — `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults `false`
- `apps/api/src/webhooks/inboundVerify.ts:52-56` — missing header → `{ valid: true }` when not required
- Route does not validate `outcome` despite a comment claiming it does

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Anyone who can reach the callback URL can attach `confirmed_fraud` / `cleared` notes (and arbitrary `outcome` strings) to any transaction UUID.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/config.ts` — `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults `false`
- `apps/api/src/webhooks/inboundVerify.ts:52-56` — missing header → `{ valid: true }` when not required
- Route does not validate `outcome` despite a comment claiming it does

Technical details:
Anyone who can reach the callback URL can attach `confirmed_fraud` / `cleared` notes (and arbitrary `outcome` strings) to any transaction UUID.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Timeline poisoning, false fraud flags, support acting on forged bank notes.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ARCHITECTURE, code audit. Legacy file: `bug-38-acquirer-callback-signature-optional.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Default the flag to true in non-dev. Reject missing/invalid signatures. Allow only `cleared` | `confirmed_fraud`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-38-acquirer-callback-signature-optional.md`

## 17. Evidence References

`apps/api/src/config.ts, apps/api/src/webhooks/inboundVerify.ts`, `bug-38-acquirer-callback-signature-optional.md`
