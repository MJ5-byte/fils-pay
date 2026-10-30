# BUG-056 — Admin Merchant Detail Form Retains State Across Route Changes

## 1. Summary

The parameterized route retains detail and form state across id changes. load neither clears old detail nor rejects obsolete responses. Mutation handlers use the current route id while heading, profile and balance use retained detail.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/admin/src/pages/merchants/MerchantDetailPage.tsx
- Reachability: Reachable in Admin Console when navigating between merchants
- Original Contributors / Sources: Blind spot investigation BUG-008

## 3. Root Cause

The parameterized route retains detail and form state across id changes. load neither clears old detail nor rejects obsolete responses. Mutation handlers use the current route id while heading, profile and balance use retained detail.

## 4. Affected Files and Functions

`apps/admin/src/router.tsx:27`; `apps/admin/src/pages/merchants/MerchantDetailPage.tsx:27-30,55-67,116-158,235-249`; `apps/admin/src/api/balanceAdjustments.ts:14-16`; `apps/api/src/routes/adminBalanceAdjustments.ts:58-74`; `apps/api/src/admin/balanceAdjustments.ts:30-45`.

## 5. Expected Behavior

The displayed merchant, form state and mutation target identify the same resource. Conflicting actions are suspended during navigation.

## 6. Actual Behavior

After A→B route navigation, A's profile stays visible while B loads. An adjustment uses id B while the screen displays A. An older A response can also overwrite a newer B response.

## 7. Trigger Conditions

A finance/super_admin navigates between detail IDs without remounting (e.g. browser history) and acts before the new request resolves, or reads resolve out of order. For adjustment, B must have a balance row.

## 8. Technical Evidence

detail is ordinary component state, not keyed by id. load sets only loadError then `setDetail(await getMerchant(id))`. Rendering uses detail.merchant; handleAdjustBalance uses `adjustBalance(id, ...)`. Backend updates merchant_balances using request.params.id.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

An authorized operator can modify the wrong merchant's balance, credit, or KYC state. This is a wrong-target UI defect; it does not claim unauthorized tenant access.

## 11. Safe Reproduction

No admin frontend navigation/delayed-response tests exist. Future case: navigate A→B with delayed detail reads; actions must remain blocked unless loaded merchant.id matches target, including reverse-order responses.

## 12. Related Findings

CODE-011's cache-only adjustment remains independent. Correcting accounting would not correct this UI target mismatch. No matching earlier finding/artifact found.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Key loaded/form state to resource identity, discard obsolete responses and require the displayed ID to match every action target. No fix implemented.

## 15. Remaining Questions and Limitations

Static ordering proof, no incorrect mutation executed. Requires same-component parameter navigation and request timing. Final reachability audit found that the current detail page links back to the list, credits and webhooks, which normally unmount this component. No direct A-to-B detail link or other ordinary UI path preserving the component was established. Browser history alone does not establish that prerequisite: navigation through the list unmounts it. The state/mutation mismatch is supported conditionally, but ordinary user reachability remains unverified; this report is not counted as a confirmed application bug.

## 16. Original Reports Merged

`bug-8-stale-admin-merchant-detail-targets-new-route.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
