# BUG-022 — Public Payment Link Endpoint Leaks Live Merchant API Key Hash

## 1. Summary

The public checkout payload includes the SHA-256 of a live merchant API key (`merchantIntegrationId`) plus the key prefix.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/routes/paymentLinks.ts
- Reachability: Reachable by any unauthenticated visitor to public link
- Original Contributors / Sources: AI code audit

## 3. Root Cause

A join meant for "which integration created this link" was serialized into the DTO.

## 4. Affected Files and Functions

- `apps/api/src/paymentLinks/read.ts:18-56` — unauthenticated `GET /v1/payment-links/:token`
- Lateral join selects `ak.key_hash AS integration_id` and `ak.key_prefix AS merchant_public_key`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The public checkout payload includes the SHA-256 of a live merchant API key (`merchantIntegrationId`) plus the key prefix. The in-file comment claims no auth material beyond display name.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/paymentLinks/read.ts:18-56` — unauthenticated `GET /v1/payment-links/:token`
- Lateral join selects `ak.key_hash AS integration_id` and `ak.key_prefix AS merchant_public_key`

Technical details:
The public checkout payload includes the SHA-256 of a live merchant API key (`merchantIntegrationId`) plus the key prefix. The in-file comment claims no auth material beyond display name.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Offline cracking / targeted attacks against merchant API keys from a URL that is emailed to buyers.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-10-payment-link-leaks-api-key-hash.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Drop the `api_keys` join and the `merchantPublicKey` / `merchantIntegrationId` fields from the public DTO.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-10-payment-link-leaks-api-key-hash.md`

## 17. Evidence References

`apps/api/src/routes/paymentLinks.ts`, `bug-10-payment-link-leaks-api-key-hash.md`
