# BUG-083 — View as Merchant Action Opens Unregistered Web Root Route

## 1. Summary

The action opens WEB_BASE_URL verbatim, defaulting to the web origin http://localhost:5173. The merchant router has no '/' route or redirect.

## 2. Classification

- Severity: Low
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/admin/src/pages/merchants/MerchantDetailPage.tsx, apps/web/src/router.tsx
- Reachability: Reachable when admin clicks 'View as merchant'
- Original Contributors / Sources: Blind spot investigation BUG-007

## 3. Root Cause

The action opens WEB_BASE_URL verbatim, defaulting to the web origin http://localhost:5173. The merchant router has no '/' route or redirect.

## 4. Affected Files and Functions

`apps/admin/src/api/client.ts:8-10`; `apps/admin/src/pages/merchants/MerchantDetailPage.tsx:213-214`; `apps/web/src/router.tsx:22-104`.

## 5. Expected Behavior

View as merchant opens an actual dashboard route.

## 6. Actual Behavior

The default URL has pathname '/' and matches no route. The manual fallback uses the same URL.

## 7. Trigger Conditions

Use the supplied default or an origin-only VITE_WEB_BASE_URL and click View as merchant.

## 8. Technical Evidence

`window.open(WEB_BASE_URL, '_blank', 'noopener')`; fallback `setImpersonationUrl(WEB_BASE_URL)`; router defines /pay/:token and /dashboard/... only.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

The operator lands on an unmatched route while a grant remains active.

## 11. Safe Reproduction

No admin frontend tests. Future test: verify generated pathname matches a registered merchant route.

## 12. Related Findings

Independent of BUG-006: fixing either bootstrap or navigation alone leaves the other obstacle. No matching earlier finding found.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Append an explicit dashboard path or add a deliberate root redirect. No fix implemented.

## 15. Remaining Questions and Limitations

A custom base URL already containing a dashboard path avoids this issue; default origin form is affected.

## 16. Original Reports Merged

`bug-7-impersonation-opens-unregistered-web-root.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
