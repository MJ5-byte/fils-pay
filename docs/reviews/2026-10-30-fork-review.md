# Fork review: 30 October 2026

Base: `zahraalhaj/fils-pay`, commit `0b3d3c383cc5c1ce5eb5f07869c2b99b122312bb`
("fixed isssues in sheets"). This review starts from the team's current
refund and finance fixes, rather than treating the original challenge code
as the latest state.

## Fixed in this branch

| Tracker | Trigger and previous result | Correction | Validation |
|---|---|---|---|
| #47 | Admin rotates a merchant key; both predecessor and replacement remain valid because verification checks revoked_at and rotation never sets it | Set revoked_at on the locked predecessor inside the existing issuance/audit transaction | Injected-client checks cover successful commit, audit failure rollback, and foreign-merchant rejection |
| #25 | A requester changes display name; the same admin ID passes the distinct-approver check. Conversely, different admins sharing a name are rejected | Compare adminUserId; preserve display names for presentation | Both identity/name edge cases plus existing approval tests |
| #59 | Caller requests a report for another marketplace's child; the relationship query checks only that the requested child exists | Require parent_merchant_id = authenticated caller as well as child_merchant_id = target | Injected-query cases cover own child, unrelated caller, reverse relationship and own reports |
| #14 | Merchant verifies the received raw JSON body; HMAC fails because signing canonicalizes but sending uses ordinary JSON.stringify | Serialize the canonical body once; signRawBody signs that string; send that same string through dispatcher and send-test transport | Independent node:crypto receiver-HMAC checks on actual captured transport bodies, including nested keys and Unicode |

The existing signPayload/verifySignature object helpers retain canonical
serialization compatibility. The HTTP body is now canonical too. Envelope
fields and signature header format are unchanged. Key rotation revokes
immediately; integrations must switch to the newly issued key.
Previously issued duplicate keys are not retroactively revoked by this
source change; operators must review and revoke old keys from earlier rotations.

## Validation performed here

- Nine new regression cases in `apps/api/src/forkReview.test.ts` use injected
  database and transport dependencies. They do not connect to a database or
  perform HTTP sends.
- Against the unchanged base with the same new test file: **7 fail, 2 pass**.
- Against this branch, including existing credit approval, signing and
  secret-encryption tests: **25 pass, 0 fail**.
- `npm run typecheck`: passed across all workspaces and db/scripts projects.
- `git diff --check`: passed.
- `npm test`: attempted, blocked by the environment denying the tsx CLI's
  Unix socket (`listen EPERM`). The focused tests use `node --import tsx
  --test` to avoid that CLI socket.
- PostgreSQL and Go are not installed in this workspace. Real database
  transaction/locking checks and the Go suite remain unverified here.
  Injected-client rollback checks establish application control flow, not
  PostgreSQL's runtime behavior.
- No seed, migration, reconciliation, settlement command, live acquirer call
  or live webhook send was run. Historical ledger data was not touched.

Reproduce the focused validation from the repository root:

```bash
node --import tsx --test apps/api/src/forkReview.test.ts apps/api/src/admin/creditApproval.test.ts apps/api/src/webhooks/sign.test.ts apps/api/src/webhooks/secretCrypto.test.ts
npm run typecheck
git diff --check
```

## Newly reviewed risks still open

These are source-level findings, not runtime reproductions. They need a
separate money-flow patch and database-backed failure/concurrency tests.

### Refund reservation can be stranded

`processRefund.ts` commits `refunded_fils += amount` before calling the
acquirer. Returned decline/error outcomes release it, but a thrown transport
exception, process exit, or journal failure does not. A successful external
refund followed by a failed local journal also leaves money movement without
a local refund/ledger record. There is no durable refund-attempt recovery
record in this path. Do not simply release reservations on every exception:
an ambiguous external result must be reconciled before another payout.

Required check: interrupt after reservation, after acquirer success, and
during journal commit; retry/recovery must produce one external refund and
one local posting, with confirmed totals distinct from pending reservations.

### Refund deficits are not carried into later payouts

The latest `CloseBatch` subtracts refunds for the current day. `PayoutBatch`
skips money legs for nonpositive net but still marks the batch paid; a later
batch computes its own net without the earlier deficit. Example: day A net
is -4,000 fils and day B net is +10,000; the current independent-day path
can pay 10,000 rather than 6,000. The team's existing documentation already
acknowledges this limitation. It is not fixed by the four changes above.

### Paid-batch MDR adjustment is not repeat-safe

The latest `RecalculateMDR` keeps a paid batch's frozen fee unchanged but
calculates each future adjustment as newFee minus that unchanged fee.
Running the same correction twice can therefore post the same difference
twice. For unpaid batches, recalculated net also uses gross minus fee without
the newly added refund/reversed-fee terms. Fixes need a durable adjustment
baseline/idempotency rule and refund-aware net calculation, not restoration
of the old behavior that rewrote paid history.

## Remaining earlier findings

Payment-link reservation expiry/double capture, public submittedAt trust,
inbound callback authentication/deduplication, payout notification races,
and large export memory usage remain outside this first follow-up patch.
The repository is not being declared fully audited or production-ready.
