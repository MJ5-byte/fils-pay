# BUG-077 — Payment Link Detail View Fails to Paginate Beyond First 100 Records

## 1. Summary

The detail page searches only the newest 100 links returned by one unfiltered list request. It ignores `nextCursor`, although the list page paginates beyond 100 and links every displayed row to that detail page.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/web/src/pages/payment-links/PaymentLinkDetailPage.tsx
- Reachability: Reachable when viewing links for merchants with >100 links
- Original Contributors / Sources: Blind spot investigation BUG-002

## 3. Root Cause

The detail page searches only the newest 100 links returned by one unfiltered list request. It ignores `nextCursor`, although the list page paginates beyond 100 and links every displayed row to that detail page.

## 4. Affected Files and Functions

`apps/web/src/pages/payment-links/PaymentLinkDetailPage.tsx:11,43-48,95-102`; `apps/web/src/pages/payment-links/PaymentLinkListPage.tsx:39-45,109`; `apps/api/src/paymentLinks/query.ts:16-17,66-85`; `apps/api/src/routes/paymentLinks.ts:119-135`.

## 5. Expected Behavior

Every own link offered by the paginated list can be opened for inspection, sharing and cancellation.

## 6. Actual Behavior

A link ranked 101 or older is shown as unavailable by the detail page even when the list has loaded it and the public link remains payable.

## 7. Trigger Conditions

A merchant has at least 101 links; open the oldest from Load more or its saved dashboard URL.

## 8. Technical Evidence

Detail: `listPaymentLinks(merchantId, { limit: LOOKUP_LIMIT })`, then `.find((link) => link.id === id)` with LOOKUP_LIMIT=100. Backend orders `created_at DESC, id DESC LIMIT $5` and returns a cursor. No authenticated single-link GET is registered in the inspected routes.

### Technical Analysis
List loads successive 25-row pages → user opens an old row → detail discards that row and fetches a new first page → ID is absent → no detail, copy or cancel controls render. This is an independent UI retrieval defect, not CODE-005's backend cancellation ownership flaw.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available. Numerical examples above are source-derived traces, not observed outputs.

## 10. Security / Financial / Functional Impact

Older invoices lose normal dashboard management. No unauthorized read or payment bypass is claimed.

## 11. Safe Reproduction

`apps/web/src/dashboard.test.ts` covers pure formatting/query helpers, not detail rendering or pagination. Future case: create 101 synthetic links, navigate from list page five and require the detail and cancellation controls to remain available.

## 12. Related Findings

No matching CODE/FINDING/NEW report or runtime artifact found. The source docblock acknowledges the limitation; it was not a prior established bug report.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Add an authenticated merchant-scoped lookup by ID or follow list cursors safely until found. No change implemented.

## 15. Remaining Questions and Limitations

Rank depends on creation order; no deployment prevalence or runtime result established.

## 16. Original Reports Merged

`bug-2-older-payment-links-unreachable-in-dashboard.md`

## 17. Evidence References

Original source and test paths listed above; [prior source investigation](../FilsPay_Complete_Source_Code_Investigation.md); [documentation investigation](../DOCS_FULL_INVESTIGATION.md). Deduplication checked across the existing bug registry, CODE/FINDING/NEW indexes and existing runtime evidence before allocation.
