# BUG-078 — Bulk KYC Selection State Retains Hidden Selections Across Tab Changes

## 1. Summary

Changing filters replaces merchants but never reconciles selectedIds. Header checked state compares set size to row count rather than membership; approval sends the stale set.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/admin/src/pages/merchants/MerchantListPage.tsx
- Reachability: Reachable when filtering and selecting in Admin KYC list
- Original Contributors / Sources: Blind spot investigation BUG-009

## 3. Root Cause

Changing filters replaces merchants but never reconciles selectedIds. Header checked state compares set size to row count rather than membership; approval sends the stale set.

## 4. Affected Files and Functions

`apps/admin/src/pages/merchants/MerchantListPage.tsx:24-29,33-58,77-101,111,143-166`; `apps/admin/src/api/merchantsBulk.ts:10-17`; `apps/api/src/routes/adminMerchantsBulk.ts`; `apps/api/src/admin/bulkKyc.ts:24-46`.

## 5. Expected Behavior

A filtered table accurately identifies selected merchants and does not imply newly visible rows are selected when only hidden rows are selected.

## 6. Actual Behavior

Select A in a one-row search, search B with one result: B is unchecked, header is checked because counts match, and Bulk approve sends A.

## 7. Trigger Conditions

Select merchants, change search/status to a disjoint dataset and invoke approval without clearing selection.

## 8. Technical Evidence

load replaces merchants at line 45 without updating selectedIds; allLoadedSelected compares sizes; approveSelected sends `[...selectedIds]`. Backend updates merchants WHERE id=ANY(submitted array).

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

KYC can be approved for merchants absent from the review table, with a falsely checked header. CODE-031's status/review bypass amplifies but is unnecessary to this UI defect.

## 11. Safe Reproduction

No admin frontend selection tests. Future case: select A, filter to B, assert header state and submitted IDs match the intended displayed selection.

## 12. Related Findings

CODE-031 is the independent server review/status bypass. This UI defect persists even if backend accepts only under_review merchants. No matching prior finding/runtime artifact.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Clear or visibly reconcile selection on dataset changes and compute header state from actual membership. No fix implemented.

## 15. Remaining Questions and Limitations

Cross-filter retention could be deliberate, but the header membership error and absent selected-identity review are concrete inconsistencies.

## 16. Original Reports Merged

`bug-9-bulk-kyc-retains-hidden-filter-selections.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
