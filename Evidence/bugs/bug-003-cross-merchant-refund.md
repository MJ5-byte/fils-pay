# BUG-003 — Missing Merchant Ownership Validation Allows Cross-Merchant Refunds

## 1. Summary

Knowing a transaction UUID is enough to refund it as that merchant.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/refunds/initiateMerchantRefund.ts
- Reachability: Reachable via authenticated refund initiation helper
- Original Contributors / Sources: AI code audit, CODE-009

## 3. Root Cause

Lookup is global; the caller's merchant is unused after `assertRefundsNotOnHold`.

## 4. Affected Files and Functions

- `apps/api/src/refunds/initiateMerchantRefund.ts:62-78`

```ts
SELECT id, merchant_id FROM transactions WHERE id = $1
// then processRefund(..., merchantId: txn.merchant_id)  // victim's id, not caller's
```

Never compares `txn.merchant_id` to `input.merchantId`.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Knowing a transaction UUID is enough to refund it as that merchant. Once Bug 12 is wired, this is a live IDOR.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/refunds/initiateMerchantRefund.ts:62-78`

```ts
SELECT id, merchant_id FROM transactions WHERE id = $1
// then processRefund(..., merchantId: txn.merchant_id)  // victim's id, not caller's
```

Never compares `txn.merchant_id` to `input.merchantId`.

Technical details:
Knowing a transaction UUID is enough to refund it as that merchant. Once Bug 12 is wired, this is a live IDOR.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Cross-tenant money movement. Combined with Bug 1, a pending-session attacker can refund other shops.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit, CODE-009. Legacy file: `bug-15-cross-merchant-refund.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

If `txn.merchant_id !== input.merchantId`, throw `NotFoundError` (do not leak existence).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-15-cross-merchant-refund.md`

## 17. Evidence References

`apps/api/src/refunds/initiateMerchantRefund.ts`, `bug-15-cross-merchant-refund.md`
