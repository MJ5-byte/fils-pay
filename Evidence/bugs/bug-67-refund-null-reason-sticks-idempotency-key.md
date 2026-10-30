# Bug 67 — A refund with no reason fails the insert and leaves the idempotency key stuck

**Severity:** High if refunds are wired (Bug 12). Not reachable over HTTP today. · **Area:** Refunds · **Source:** CODE-009, EVID-016, EVID-017, EVID-018

## Where
- `apps/api/src/payments/processRefund.ts:189` — `reason` is inserted as `input.reason ?? null`
- `db/migrations/0070_refund_reason_default.sql:8-9` — `CHECK (reason IS NOT NULL)`. A column default of `'unspecified'` does not apply when the INSERT passes NULL explicitly.
- `apps/api/src/payments/idempotency.ts:170-178` — a claim left `in_progress` is a permanent conflict. The comment points at `scripts/sweep_idempotency.ts`, which is not in the repo.

## What's wrong
Phase 1 commits the idempotency claim. Phase 3 then inserts the refund. With no reason, Postgres rejects the row (`23514`, reproduced in EVID-016/017/018). The claim stays `in_progress` forever, so the same key can never be retried. If the acquirer call in phase 2 already succeeded, the card is refunded and the ledger has no legs.

## Why
The helper treats `reason` as optional. The constraint, added later, does not.

## What it breaks
The first attempt to wire refunds without a reason fails closed on the ledger and fails open at the acquirer, and the merchant cannot retry that idempotency key.

## Smallest fix
Require `reason` before the acquirer call, or insert the column default by omitting the column. Mark the claim `failed` when phase 3 throws. Do not call the acquirer until the ledger transaction is ready to commit.
