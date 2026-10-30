# BUG-028 — Refund with Null Reason Violates DB Constraint Leaving Idempotency Key Stuck

## 1. Summary

Phase 1 commits the idempotency claim.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Refunds
- Affected Component: apps/api/src/payments/processRefund.ts, db/migrations/0070_refund_reason_default.sql
- Reachability: Reachable when refunds are processed without reason
- Original Contributors / Sources: CODE-009, EVID-016, EVID-017, EVID-018

## 3. Root Cause

The helper treats `reason` as optional. The constraint, added later, does not.

## 4. Affected Files and Functions

- `apps/api/src/payments/processRefund.ts:189` — `reason` is inserted as `input.reason ?? null`
- `db/migrations/0070_refund_reason_default.sql:8-9` — `CHECK (reason IS NOT NULL)`. A column default of `'unspecified'` does not apply when the INSERT passes NULL explicitly.
- `apps/api/src/payments/idempotency.ts:170-178` — a claim left `in_progress` is a permanent conflict. The comment points at `scripts/sweep_idempotency.ts`, which is not in the repo.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Phase 1 commits the idempotency claim. Phase 3 then inserts the refund. With no reason, Postgres rejects the row (`23514`, reproduced in EVID-016/017/018). The claim stays `in_progress` forever, so the same key can never be retried. If the acquirer call in phase 2 already succeeded, the card is refunded and the ledger has no legs.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/payments/processRefund.ts:189` — `reason` is inserted as `input.reason ?? null`
- `db/migrations/0070_refund_reason_default.sql:8-9` — `CHECK (reason IS NOT NULL)`. A column default of `'unspecified'` does not apply when the INSERT passes NULL explicitly.
- `apps/api/src/payments/idempotency.ts:170-178` — a claim left `in_progress` is a permanent conflict. The comment points at `scripts/sweep_idempotency.ts`, which is not in the repo.

Technical details:
Phase 1 commits the idempotency claim. Phase 3 then inserts the refund. With no reason, Postgres rejects the row (`23514`, reproduced in EVID-016/017/018). The claim stays `in_progress` forever, so the same key can never be retried. If the acquirer call in phase 2 already succeeded, the card is refunded and the ledger has no legs.

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

The first attempt to wire refunds without a reason fails closed on the ledger and fails open at the acquirer, and the merchant cannot retry that idempotency key.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: CODE-009, EVID-016, EVID-017, EVID-018. Legacy file: `bug-67-refund-null-reason-sticks-idempotency-key.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Require `reason` before the acquirer call, or insert the column default by omitting the column. Mark the claim `failed` when phase 3 throws. Do not call the acquirer until the ledger transaction is ready to commit.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-67-refund-null-reason-sticks-idempotency-key.md`

## 17. Evidence References

`apps/api/src/payments/processRefund.ts, db/migrations/0070_refund_reason_default.sql`, `bug-67-refund-null-reason-sticks-idempotency-key.md`
