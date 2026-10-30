# BUG-027 — POST /v1/refunds Route Returns 501 Not Implemented (Unfinished Feature)

## 1. Summary

The route exists, auth is wired, helpers and tests exist, and the ledger/fee-reversal logic is written — but the handler always sends `{ error: "not_implemented" }`.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Refunds
- Affected Component: apps/api/src/routes/refunds.ts
- Reachability: Reachable via POST /v1/refunds
- Original Contributors / Sources: Support FP-300, YA handover

## 3. Root Cause

Feature was started (YA) and left unwired. Agent rules say "do not fix the 501" — those rules are decoys. HANDOVER and FP-300 say to finish it.

## 4. Affected Files and Functions

- `apps/api/src/routes/refunds.ts:22-25` — stub
- Implemented but unwired: `apps/api/src/payments/processRefund.ts`, `apps/api/src/refunds/initiateMerchantRefund.ts`
- Dashboard drawer commented out: `apps/web/src/pages/transactions/RefundDrawer.tsx`
- Migrations 0042–0044, 0070–0072 already exist

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The route exists, auth is wired, helpers and tests exist, and the ledger/fee-reversal logic is written — but the handler always sends `{ error: "not_implemented" }`. There is also no `POST /v1/merchants/:id/refunds`. Comments in the stub even include a Claude-drafted handler that was never used.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/routes/refunds.ts:22-25` — stub
- Implemented but unwired: `apps/api/src/payments/processRefund.ts`, `apps/api/src/refunds/initiateMerchantRefund.ts`
- Dashboard drawer commented out: `apps/web/src/pages/transactions/RefundDrawer.tsx`
- Migrations 0042–0044, 0070–0072 already exist

Technical details:
The route exists, auth is wired, helpers and tests exist, and the ledger/fee-reversal logic is written — but the handler always sends `{ error: "not_implemented" }`. There is also no `POST /v1/merchants/:id/refunds`. Comments in the stub even include a Claude-drafted handler that was never used.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Merchants cannot refund. FP-300's "works from start to end, money is right, webhooks, timeline, reports" is this flow. Wiring it without Bugs 13–15 first will lose money.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Support FP-300, YA handover. Legacy file: `bug-12-refunds-route-returns-501.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Register a merchant-scoped route that calls `initiateMerchantRefund` with the idempotency header. Fix Bugs 13–15 first. Emit `refund.succeeded` (today it is missing from `WEBHOOK_ELIGIBLE_EVENT_TYPES` — another decoy "intentional"). Show it in timeline/reports.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-12-refunds-route-returns-501.md`

## 17. Evidence References

`apps/api/src/routes/refunds.ts`, `bug-12-refunds-route-returns-501.md`
