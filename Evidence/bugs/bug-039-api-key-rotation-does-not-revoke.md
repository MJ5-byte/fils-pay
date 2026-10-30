# BUG-039 — API Key Rotation Mints New Key Without Revoking Existing Active Key

## 1. Summary

After rotation, both keys work.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Admin console and controls
- Affected Component: apps/api/src/admin/apiKeys.ts
- Reachability: Reachable via POST /v1/admin/merchants/:id/api-keys/rotate
- Original Contributors / Sources: ADMIN.md, code audit

## 3. Root Cause

Rotation was implemented as "issue another key and remember the parent," not "replace."

## 4. Affected Files and Functions

- `apps/api/src/admin/apiKeys.ts:31-46` — issues a new key with `rotatedFromKeyId`, never `UPDATE … SET revoked_at`
- `apps/api/src/apiKeys/issue.ts` — `revokeApiKey` exists and is unused on this path

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

After rotation, both keys work. The audit row says `api_key_rotate`. The old secret remains valid indefinitely.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/admin/apiKeys.ts:31-46` — issues a new key with `rotatedFromKeyId`, never `UPDATE … SET revoked_at`
- `apps/api/src/apiKeys/issue.ts` — `revokeApiKey` exists and is unused on this path

Technical details:
After rotation, both keys work. The audit row says `api_key_rotate`. The old secret remains valid indefinitely.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

A leaked key that was "rotated" is still live. Incident response that relies on rotation does nothing.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ADMIN.md, code audit. Legacy file: `bug-44-api-key-rotation-does-not-revoke.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

In the same transaction, `UPDATE api_keys SET revoked_at = now() WHERE id = $oldId`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-44-api-key-rotation-does-not-revoke.md`

## 17. Evidence References

`apps/api/src/admin/apiKeys.ts`, `bug-44-api-key-rotation-does-not-revoke.md`
