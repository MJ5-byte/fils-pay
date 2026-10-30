# BUG-065 — Settlement Reconciliation Equations Subtract Paid Batches Twice

## 1. Summary

The ledger side includes every merchant_payable debit, including completed payouts, while the comparison independently subtracts closed and paid batch net amounts. A range containing both captures and their payouts therefore subtracts payouts twice.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/api/src/settlement/query.ts
- Reachability: Reachable on GET /v1/settlement/reconciliation
- Original Contributors / Sources: Blind spot investigation BUG-003

## 3. Root Cause

The ledger side includes every merchant_payable debit, including completed payouts, while the comparison independently subtracts closed and paid batch net amounts. A range containing both captures and their payouts therefore subtracts payouts twice.

## 4. Affected Files and Functions

`apps/api/src/settlement/query.ts:281-343`; `apps/api/src/routes/settlement.ts:59-73`; `apps/settlement/internal/settlement/batch.go:330-342`; `apps/api/src/routes/settlement.test.ts:158-172,348-385`; `apps/web/src/pages/settlement/ReconciliationPage.tsx:115,125-137`.

## 5. Expected Behavior

A fully captured, correctly paid period reconciles without unexplained differences when both business dates and payout times fall in the selected range.

## 6. Actual Behavior

With net captured 9,750 fils and its 9,750-fil payout inside the report range, ledger net is zero, batch net is 9,750, pending is zero and gap is -9,750, despite correct journal entries.

## 7. Trigger Conditions

Capture 10,000 fils at 250 bps with no discount/tier; close and pay on the following day; request a range spanning both days. Small exact amounts avoid CODE-019 precision effects.

## 8. Technical Evidence

`query.ts:290-293` sums all payable credits minus debits by occurred_at, with no exclusion of payout rows. Lines 297-300 sum `net_payout_fils` for `status IN ('closed','paid')` by batch_date. Line 333 subtracts the latter. `batch.go:340` posts the payout debit using `now()`.

### Technical Analysis
The report mixes a movement net already reduced by disbursements with batch obligations before payout. A normal multi-day range includes both legs. Ranges may also include payouts of batches outside the selected business-date range, making the two cohorts diverge. The static example requires no refund, schedule change, cache drift or rounding defect.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available. Numerical examples above are source-derived traces, not observed outputs.

## 10. Security / Financial / Functional Impact

Normal paid periods are flagged as unexplained financial discrepancies. The known signed-formatting problem can additionally crash the merchant report when this negative gap is rendered; that existing defect is not counted again.

## 11. Safe Reproduction

The fully batched test deliberately sets payoutOccurredAt to next-day noon, then queries exactly the capture day (`settlement.test.ts:161-172,358-385`). This keeps the payout debit outside the selected window. Future case: use the same fixture but query across capture and payout dates and assert a zero gap.

## 12. Related Findings

CODE-019/020/021 concern payout precision, cache sources and fee formulas. This report is independently caused by the reconciliation equation. Prior source report section 12 only skimmed the query; no duplicate finding or matching runtime result found.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Compare consistent capture obligations with batch allocations, or explicitly add back corresponding payout debits and align cohorts. No fix implemented.

## 15. Remaining Questions and Limitations

Static accounting scenario; no production prevalence established. Negative UI formatting was already mentioned by the prior source report.

## 16. Original Reports Merged

`bug-3-reconciliation-subtracts-paid-batches-twice.md`

## 17. Evidence References

Original source and test paths listed above; [prior source investigation](../FilsPay_Complete_Source_Code_Investigation.md); [documentation investigation](../DOCS_FULL_INVESTIGATION.md). Deduplication checked across the existing bug registry, CODE/FINDING/NEW indexes and existing runtime evidence before allocation.
