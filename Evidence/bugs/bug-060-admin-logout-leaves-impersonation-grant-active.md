# BUG-060 — Admin Sign-Out Revokes Admin Session but Leaves Impersonation Grant Active

## 1. Summary

Admin signOut clears local impersonation metadata but calls only the admin logout endpoint. That endpoint revokes the admin session and clears only the admin cookie. Grant validation is independent of the logged-out session.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authentication and sessions
- Affected Component: apps/admin/src/auth/AdminAuthContext.tsx, apps/api/src/routes/adminAuth.ts
- Reachability: Reachable when an admin logs out while holding active impersonation grant
- Original Contributors / Sources: Blind spot investigation BUG-011

## 3. Root Cause

Admin signOut clears local impersonation metadata but calls only the admin logout endpoint. That endpoint revokes the admin session and clears only the admin cookie. Grant validation is independent of the logged-out session.

## 4. Affected Files and Functions

`apps/admin/src/auth/AdminAuthContext.tsx:97-105`; `apps/admin/src/api/auth.ts:23-24`; `apps/api/src/routes/adminAuth.ts:204-220`; `apps/api/src/admin/impersonation.ts:106-132`; `apps/api/src/auth/requireMerchantAuth.ts:85-97`.

## 5. Expected Behavior

Logging out ends the browser's active impersonation or explicitly retains visible control of it until it is ended.

## 6. Actual Behavior

After a successful admin logout, the impersonation cookie and grant still authorize merchant API requests until their own expiry, but the console forgets the grant and hides its banner/exit action.

## 7. Trigger Conditions

Create a grant and click admin Log out while it is active. Merchant requests then use the still-present fp_impersonation cookie without fp_sid. Default residual lifetime is up to fifteen minutes.

## 8. Technical Evidence

AdminAuthContext finally calls clearActiveImpersonation and setImpersonation(null), without endImpersonation. routes/adminAuth.ts revokes only auth.adminSessionId. lookupImpersonationGrant checks grant expiry/revoked/ended, not admin session membership; role joins remain active after logout.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

A shared browser can retain merchant access after the operator believes they have logged out. Known CODE-007 expands grants' write authority, but residual read authority alone establishes this lifecycle defect.

## 11. Safe Reproduction

No admin frontend test covers logout with an active grant. Existing backend tests exercise grant creation/end but do not make logout revoke it. Future case: start grant, logout, verify no subsequent merchant API access from its browser credential.

## 12. Related Findings

CODE-007 covers disabled-admin grants and write roles. This separately reachable logout path fails to end the grant while discarding its UI record. No prior matching runtime reproduction.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

End active grants and clear their cookie as part of logout, with server-side session binding/revocation appropriate to the product invariant. No fix implemented.

## 15. Remaining Questions and Limitations

The merchant dashboard bootstrap defect BUG-006 limits the normal UI journey, but does not prevent direct merchant API use of the retained grant.

## 16. Original Reports Merged

`bug-11-admin-logout-leaves-impersonation-grant-active.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
