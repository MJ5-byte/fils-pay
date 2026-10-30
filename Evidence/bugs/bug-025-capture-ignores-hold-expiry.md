# BUG-025 — Capture Ignores Hold Expiry and Succeeds Against Expired Authorizations

## 1. Summary

A capture of a 8-day-old authorization succeeds locally.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Payments and payment links
- Affected Component: apps/api/src/payments/capture.ts
- Reachability: Reachable via capture endpoint
- Original Contributors / Sources: HANDOVER, ARCHITECTURE

## 3. Root Cause

Capture is keyed only on `transactions`; the hold is a side table that nothing consults at capture time.

## 4. Affected Files and Functions

- `apps/api/src/payments/capture.ts:119-151` — captures under a transaction row lock; never reads `holds.status` / `holds.expires_at`
- `apps/api/src/payments/authorize.ts` — hold `expires_at = now() + 7 days`
- `scripts/expire_holds.ts` — **DELETE**s expired active holds; the transaction stays `authorized`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A capture of a 8-day-old authorization succeeds locally. After the nightly janitor, there is not even a hold row, and capture still succeeds. Architecture and HANDOVER say holds are flipped to `expired`, never deleted.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/capture.ts:119-151` — captures under a transaction row lock; never reads `holds.status` / `holds.expires_at`
- `apps/api/src/payments/authorize.ts` — hold `expires_at = now() + 7 days`
- `scripts/expire_holds.ts` — **DELETE**s expired active holds; the transaction stays `authorized`

Technical details:
A capture of a 8-day-old authorization succeeds locally. After the nightly janitor, there is not even a hold row, and capture still succeeds. Architecture and HANDOVER say holds are flipped to `expired`, never deleted.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Captures against dead authorizations. Ledger with no matching hold. Real acquirer may decline or post a late capture the issuer will dispute.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: HANDOVER, ARCHITECTURE. Legacy file: `bug-17-capture-ignores-hold-expiry.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Under the row lock, join `holds` and reject if missing, not `active`, or `expires_at <= now()`. Janitor should `UPDATE holds SET status = 'expired'` **and** expire the transaction, not DELETE (see Bug 32).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-17-capture-ignores-hold-expiry.md`

## 17. Evidence References

`apps/api/src/payments/capture.ts`, `bug-17-capture-ignores-hold-expiry.md`
