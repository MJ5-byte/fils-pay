# BUG-050 — Payout Disbursement Bank Record Created as Side Effect of Webhook Dispatch

## 1. Summary

A money-side-effect (we recorded a bank disbursement) is triggered by **attempting** to tell the merchant.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/dispatcher.ts, payoutDisbursement.ts
- Reachability: Reachable on first webhook delivery attempt
- Original Contributors / Sources: Incident 2026-08-21, migration 0057

## 3. Root Cause

Side effect was bolted onto first delivery to "keep it in one place."

## 4. Affected Files and Functions

- `apps/api/src/webhooks/dispatcher.ts:37-41, 160-163` — `PRE_DELIVERY_EFFECTS['settlement.paid']` runs when `attempt_count === 0`
- `apps/api/src/webhooks/payoutDisbursement.ts` — plain INSERT, no unique on `settlement_batch_id`
- `db/migrations/0057_settlement_payout_disbursements.sql`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A money-side-effect (we recorded a bank disbursement) is triggered by **attempting** to tell the merchant. One outbox event × N endpoints = N rows. Replays mint a new delivery with `attempt_count === 0` again (Bug 42). The Go `PayoutBatch` path that should own this does not.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/dispatcher.ts:37-41, 160-163` — `PRE_DELIVERY_EFFECTS['settlement.paid']` runs when `attempt_count === 0`
- `apps/api/src/webhooks/payoutDisbursement.ts` — plain INSERT, no unique on `settlement_batch_id`
- `db/migrations/0057_settlement_payout_disbursements.sql`

Technical details:
A money-side-effect (we recorded a bank disbursement) is triggered by **attempting** to tell the merchant. One outbox event × N endpoints = N rows. Replays mint a new delivery with `attempt_count === 0` again (Bug 42). The Go `PayoutBatch` path that should own this does not.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Ops sees multiple disbursements per batch. Finance thinks we paid twice. A failed webhook can still have recorded a payout — or a successful payout can be recorded twice.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Incident 2026-08-21, migration 0057. Legacy file: `bug-41-payout-disbursement-recorded-by-webhook.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Record disbursement inside `PayoutBatch` only. Remove the dispatcher effect. `UNIQUE (settlement_batch_id)`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-41-payout-disbursement-recorded-by-webhook.md`

## 17. Evidence References

`apps/api/src/webhooks/dispatcher.ts, payoutDisbursement.ts`, `bug-41-payout-disbursement-recorded-by-webhook.md`
