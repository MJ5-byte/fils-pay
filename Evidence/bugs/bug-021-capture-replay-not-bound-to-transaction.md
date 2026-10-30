# BUG-021 — Capture Idempotency Key Is Not Bound to Transaction ID Allowing Tenant Replay

## 1. Summary

Capture claims use the same endpoint namespace for all transaction IDs and hash only amountFils. A completed key replays before the target's ownership lookup. The route nevertheless invokes the discount helper using the requested path ID; that helper reads capture events by transaction ID without checking merchant ownership.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authorization and tenant isolation
- Affected Component: apps/api/src/payments/capture.ts, apps/api/src/payments/idempotency.ts
- Reachability: Reachable via transaction capture endpoint
- Original Contributors / Sources: Blind spot investigation BUG-015

## 3. Root Cause

Capture claims use the same endpoint namespace for all transaction IDs and hash only amountFils. A completed key replays before the target's ownership lookup. The route nevertheless invokes the discount helper using the requested path ID; that helper reads capture events by transaction ID without checking merchant ownership.

## 4. Affected Files and Functions

`apps/api/src/payments/capture.ts:44,94-121`; `apps/api/src/routes/transactions.ts:94-115`; `apps/api/src/payments/discountAdjustment.ts:39-83`; `apps/api/src/payments/idempotency.ts:119-158`; `db/migrations/0007_ledger_double_entry.sql:21-33`.

## 5. Expected Behavior

A repeated key is bound to its original transaction/resource. Requests against another target cannot reuse an earlier success or trigger target-specific effects before ownership validation.

## 6. Actual Behavior

A successful capture key for A replays as HTTP 200 at a different path B with the same amount body, without capturing or checking B. For a discounted caller and a known foreign B with an unadjusted positive-fee capture event, the subsequent helper credits the caller's merchant_payable using B's fee metadata and transaction ID.

## 7. Trigger Conditions

Caller has a valid merchant credential, a completed successful capture key/body, and nonzero negotiated discount. For the cross-tenant journal scenario, caller also knows B's transaction UUID and B has more capture events than discount rows (e.g. a hosted-link capture, whose helper is not called). Ordinary wrong-resource replay needs no discount or foreign tenant.

## 8. Technical Evidence

requestHash=`hashRequest({amountFils: input.amountFils ?? null})`; ENDPOINT='transactions.capture'. Replay returns before SELECT id AND merchant_id FOR UPDATE. Route calls applyCaptureDiscountAdjustment with auth merchantId and path transactionId. Helper's transaction lock/count/latest-event queries constrain only transactionId, then inserts merchantId from caller. Ledger merchant_id and transaction_id are separate foreign keys, not a composite ownership constraint.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Wrong-resource success responses and, under stated preconditions, unauthorized cross-tenant event attribution and unearned merchant credit. No claim of a real acquirer refund or bank transfer; the confirmed side effect is journal posting.

## 11. Safe Reproduction

Existing pure idempotency tests compare JSON hash properties, not route resource identity. Discount helper tests use matching merchant/transaction pairs only. Future cases: same key/body against another own transaction and a foreign transaction; require rejection and unchanged ledger.

## 12. Related Findings

CODE-007's role gates, CODE-009's dormant refund scoping and CODE-021's fee formulas are distinct. BUG-014 is an independent count/zero-marker error; this path works with one foreign unadjusted capture even without a zero-discount event.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Bind transaction ID to capture request hash/scope, verify replay resource identity, and independently scope every adjustment query to its merchant and exact event. No fix implemented.

## 15. Remaining Questions and Limitations

Foreign UUID must be known; no enumeration or production exploitation demonstrated. A matching deployed schema is assumed; no application execution.

## 16. Original Reports Merged

`bug-15-capture-replay-not-bound-to-transaction.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
