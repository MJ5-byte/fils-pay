# BUG-005 — Payment Link Can Be Paid After Expiry via Client submittedAt Spoofing

## 1. Summary

Expiry is evaluated against attacker-controlled `submittedAt`, not server time.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/paymentLinks/pay.ts
- Reachability: Reachable via public checkout endpoint
- Original Contributors / Sources: Clue FP-187, ARCHITECTURE

## 3. Root Cause

A public, unauthenticated endpoint trusts a client-supplied clock "so a retry after midnight is not penalised."

## 4. Affected Files and Functions

- `apps/api/src/paymentLinks/pay.ts:34-37, 60, 73-75` — `expiryReferenceTime(submittedAt)`
- `apps/api/src/routes/paymentLinks.ts:34-37, 155-166` — public pay forwards body `submittedAt` (comment says ignore unless API-key auth; it does not)
- `apps/web/src/pages/checkout/CheckoutPage.tsx:59-63` — honest checkout sends client clock

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Expiry is evaluated against attacker-controlled `submittedAt`, not server time. `GET` uses the server clock (link shows "expired"); `POST …/pay` accepts a timestamp from before `expires_at`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/paymentLinks/pay.ts:34-37, 60, 73-75` — `expiryReferenceTime(submittedAt)`
- `apps/api/src/routes/paymentLinks.ts:34-37, 155-166` — public pay forwards body `submittedAt` (comment says ignore unless API-key auth; it does not)
- `apps/web/src/pages/checkout/CheckoutPage.tsx:59-63` — honest checkout sends client clock

Technical details:
Expiry is evaluated against attacker-controlled `submittedAt`, not server time. `GET` uses the server clock (link shows "expired"); `POST …/pay` accepts a timestamp from before `expires_at`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Expired invoices stay payable forever. A buyer (or anyone with the token) backdates `submittedAt` and is charged.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue FP-187, ARCHITECTURE. Legacy file: `bug-6-payment-link-paid-after-expiry.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

On the public pay route, ignore `submittedAt` (always `new Date()`). If offline terminals need it, put it on a separate authenticated route and clamp to a short server-side window.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-6-payment-link-paid-after-expiry.md`

## 17. Evidence References

`apps/api/src/paymentLinks/pay.ts`, `bug-6-payment-link-paid-after-expiry.md`
