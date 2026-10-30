# BUG-024 — Void Operation Does Not Reverse External Acquirer Authorization Hold

## 1. Summary

Void marks the payment voided in FilsPay.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/payments/void.ts
- Reachability: Reachable via POST /v1/transactions/:id/void
- Original Contributors / Sources: AI code audit

## 3. Root Cause

Acquirer client was never given a reverse method; void was implemented as a local state change.

## 4. Affected Files and Functions

- `apps/api/src/payments/void.ts:31-34, 66-79` — local `transactions` + `holds` only; comment says no acquirer call
- `apps/api/src/acquirer/types.ts` — no `void` / `reverseAuthorization` on the interface

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Void marks the payment voided in FilsPay. The issuer-side hold remains until it lapses. Combined with payment-link capture failure (Bug 7), customers keep blocked funds after we told them the payment was cancelled.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/void.ts:31-34, 66-79` — local `transactions` + `holds` only; comment says no acquirer call
- `apps/api/src/acquirer/types.ts` — no `void` / `reverseAuthorization` on the interface

Technical details:
Void marks the payment voided in FilsPay. The issuer-side hold remains until it lapses. Combined with payment-link capture failure (Bug 7), customers keep blocked funds after we told them the payment was cancelled.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Cardholder funds stay held. Chargebacks / complaints. Dashboard lies.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-16-void-does-not-reverse-authorization.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Add `reverseAuthorization` to the acquirer client and call it from `voidTransaction` **before** marking voided. On acquirer failure, do not locally void.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-16-void-does-not-reverse-authorization.md`

## 17. Evidence References

`apps/api/src/payments/void.ts`, `bug-16-void-does-not-reverse-authorization.md`
