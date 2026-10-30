# BUG-066 — Pending Reconciliation Replaces Actual Capture Fees with Default MDR Estimator

## 1. Summary

Pending reconciliation reads only each event amount, then estimates fees from the merchant's current default MDR and discount using Math.round. It discards event fee metadata and does not resolve the effective schedule or tier used by capture.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/api/src/settlement/query.ts, apps/api/src/fees/estimate.ts
- Reachability: Reachable on settlement reconciliation for unbatched captures
- Original Contributors / Sources: Blind spot investigation BUG-005

## 3. Root Cause

Pending reconciliation reads only each event amount, then estimates fees from the merchant's current default MDR and discount using Math.round. It discards event fee metadata and does not resolve the effective schedule or tier used by capture.

## 4. Affected Files and Functions

`apps/api/src/settlement/query.ts:303-328`; `apps/api/src/fees/estimate.ts:1-11`; `apps/api/src/fees/feeSchedule.ts:22-35`; `apps/api/src/payments/capture.ts:195-196,258-265`; `apps/api/src/routes/settlement.test.ts:388-412`.

## 5. Expected Behavior

Pending net attributes the actual booked payable movement for each unbatched capture so unchanged, correctly booked activity has no unexplained gap.

## 6. Actual Behavior

Default MDR 250 bps plus an applicable schedule of 200 bps, no discount/tier, capture 10,000 fils: ledger net is 9,800; pending estimator reports 9,750; report falsely shows +50 gap. Even at identical 250 bps, a 20-fil capture has a 0.5-fil fee rounded half-even to zero by capture but Math.round to one by the estimator.

## 7. Trigger Conditions

An unbatched capture has an applicable schedule different from merchants.mdr_bps, a tier adjustment, or a rounding tie. No Go settlement batch or fee mismatch is required.

## 8. Technical Evidence

`query.ts:304` selects te.amount_fils only; lines 312-327 load merchants.mdr_bps and call estimateFeeFils. `estimate.ts:10` uses Math.round. `feeSchedule.ts:29-32` resolves by effective_from; capture uses applyRateFils and records feeFils in event metadata.

### Technical Analysis
Merchant captures → accurate ledger and event fee → reconciliation recomputes a different fee → false pending amount and gap. Group all estimator discrepancies here because preserving actual event accounting fixes the shared attribution error.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available. Numerical examples above are source-derived traces, not observed outputs.

## 10. Security / Financial / Functional Impact

False discrepancies before settlement and mutable historical attribution when the default MDR changes. No new direct overcharge is claimed.

## 11. Safe Reproduction

`settlement.test.ts:388-412` tests only 2,000 fils at default 250 bps with no schedule, discount or tier. Future cases: 10,000 at a 200-bps effective schedule over a 250-bps default, plus a 20-fil half-even tie.

## 12. Related Findings

CODE-021 documents TS capture versus Go batch fee divergence, which is distinct: this defect occurs before any batch. CODE-038 labels fees/estimate.ts dead/unwired; the inspected reconciliation caller contradicts that label. No matching runtime artifact found.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Attribute pending net using persisted capture fee/ledger facts, including adjustments, rather than repricing with current defaults. No fix implemented.

## 15. Remaining Questions and Limitations

Exact impact of negotiated discount adjustments requires consistent event/ledger attribution. The schedule-only and tie examples avoid that uncertainty.

## 16. Original Reports Merged

`bug-5-pending-reconciliation-reprices-captures-with-default-mdr.md`

## 17. Evidence References

Original source and test paths listed above; [prior source investigation](../FilsPay_Complete_Source_Code_Investigation.md); [documentation investigation](../DOCS_FULL_INVESTIGATION.md). Deduplication checked across the existing bug registry, CODE/FINDING/NEW indexes and existing runtime evidence before allocation.
