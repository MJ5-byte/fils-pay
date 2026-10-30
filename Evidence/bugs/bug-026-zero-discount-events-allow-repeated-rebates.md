# BUG-026 — Zero-Discount Capture Events Allow Retries to Post Repeated Rebate Adjustments

## 1. Summary

Discount idempotency compares capture-event count with positive adjustment-row count. Zero-fee or zero-rounded-discount events create no marker, while every later invocation selects only the newest event's fee.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/payments/discountAdjustment.ts
- Reachability: Reachable on capture retry with discount
- Original Contributors / Sources: Blind spot investigation BUG-014

## 3. Root Cause

Discount idempotency compares capture-event count with positive adjustment-row count. Zero-fee or zero-rounded-discount events create no marker, while every later invocation selects only the newest event's fee.

## 4. Affected Files and Functions

`apps/api/src/payments/discountAdjustment.ts:49-84`; `apps/api/src/routes/transactions.ts:104-115`; `apps/api/src/payments/capture.ts:107-121`; `apps/api/src/payments/discountAdjustment.test.ts:94-126`.

## 5. Expected Behavior

Each capture's discount is applied at most once, including zero-value results; retries do not change ledger state.

## 6. Actual Behavior

At 250-bps MDR and 10% discount: capture 1 fil (fee and discount 0), then capture 1,000 fils (fee 25, rebate 2). One rebate row exists for two events. Replaying the successful second capture posts another 2-fil rebate, although no new capture occurred. More zero-discount events provide more repeat slots.

## 7. Trigger Conditions

A merchant with negotiated discount makes at least one capture whose rebate is zero followed by a positive-rebate capture, then retries a completed capture using its original key/body. No concurrency or Go batch needed.

## 8. Technical Evidence

discountAdjustment count query counts every capture but only credit legs with its adjustment description. Lines 70-74 return without a row for fee/rebate zero. Latest event SELECT uses ORDER BY occurred_at DESC,id DESC LIMIT 1. Route calls helper after every 200, including cached replay.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Repeated requests credit merchant_payable and debit platform_fee_revenue more than the agreed discount. Ordinary capture idempotency succeeds, yet its route-level side effect is not idempotent.

## 11. Safe Reproduction

Existing tests separately check a zero-rounded adjustment and a repeated positive single-event adjustment. They never combine the two on one transaction. Future case: zero event, positive event, identical HTTP replay; assert rebate total and ledger groups unchanged on replay.

## 12. Related Findings

CODE-021 covers formula divergence/non-atomic adjustment and missing link discounts. This is a separate count-based idempotency error that survives making the formula agree. No matching runtime artifact or earlier finding.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Persist event-specific processing identity including zero rebates and associate every adjustment with the exact capture event. Do not infer processing from aggregate counts. No fix implemented.

## 15. Remaining Questions and Limitations

Numerical example derived statically; no refund, bank payout or exploit was executed. Cached balance may update independently of the journal.

## 16. Original Reports Merged

`bug-14-zero-discount-events-allow-repeated-rebates.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
