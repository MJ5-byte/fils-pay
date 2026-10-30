# BUG-018 — Payment Link Cancellation Endpoint Lacks Merchant Scoping

## 1. Summary

Any authenticated merchant who knows another merchant's link UUID can cancel it via `DELETE /v1/merchants/{theirId}/payment-links/{victimLinkId}`..

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/routes/paymentLinks.ts
- Reachability: Reachable via authenticated merchant payment link cancel
- Original Contributors / Sources: Clue 'Cancel B link from A dashboard'

## 3. Root Cause

The UPDATE is keyed only on link id. Ownership is never joined.

## 4. Affected Files and Functions

- `apps/api/src/paymentLinks/cancel.ts:13-28` — `UPDATE … WHERE id = $1 AND status = 'active'` (no `merchant_id`)
- `apps/api/src/routes/paymentLinks.ts` — `assertOwnMerchant` only checks the path `:merchantId`, not that the link belongs to it

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Any authenticated merchant who knows another merchant's link UUID can cancel it via `DELETE /v1/merchants/{theirId}/payment-links/{victimLinkId}`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/paymentLinks/cancel.ts:13-28` — `UPDATE … WHERE id = $1 AND status = 'active'` (no `merchant_id`)
- `apps/api/src/routes/paymentLinks.ts` — `assertOwnMerchant` only checks the path `:merchantId`, not that the link belongs to it

Technical details:
Any authenticated merchant who knows another merchant's link UUID can cancel it via `DELETE /v1/merchants/{theirId}/payment-links/{victimLinkId}`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Cross-tenant denial of payment. Merchant A's dashboard can kill Merchant B's live checkout.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'Cancel B link from A dashboard'. Legacy file: `bug-8-payment-link-cancel-cross-merchant.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Pass `merchantId` into `cancelPaymentLink` and add `AND merchant_id = $2` on both the UPDATE and the follow-up SELECT.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-8-payment-link-cancel-cross-merchant.md`

## 17. Evidence References

`apps/api/src/routes/paymentLinks.ts`, `bug-8-payment-link-cancel-cross-merchant.md`
