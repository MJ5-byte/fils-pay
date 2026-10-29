# FilsPay architecture

Written by YA (Feb 2026); updated by MK (settlement, admin), FH (audit prep)
and AM (ops). Where it disagrees with the code, the code wins — raise a ticket.

---

## Overview

FilsPay is a handful of services around a single Postgres 16 database:

| Component | Language | Responsibility |
|---|---|---|
| `apps/api` | TypeScript / Fastify | Merchant, checkout and admin HTTP API; webhook dispatcher; acquirer client |
| `apps/settlement` | Go | Daily batch close, fees, payouts, scheme file export, balance cache |
| `apps/reporting` | TypeScript | Analytics read model, fed from the outbox |
| `packages/money` | TypeScript | Fils type, parsing/formatting, rate and allocation helpers |
| `packages/events` | TypeScript | Outbox event types and `enqueueEvent` |

Services communicate through the database: a transactional outbox plus
`LISTEN/NOTIFY` for wake-ups, and a small authenticated internal HTTP API on
the settlement worker for admin-triggered operations.

## Money

All amounts are integers in fils (1 BD = 1000 fils). Money columns end in
`_fils` and are `BIGINT`; TypeScript carries the branded `Fils` type and Go
uses `money.Fils` (`int64`). Text input is converted with `parseBhdToFils`;
rates are integer basis points. `applyRateFils` rounds half-to-even.

The card scheme settles in two decimals. `apps/settlement` truncates each
exported line to a multiple of 10 fils at batch close.

## The ledger

`ledger_entries` is the record of money movements. Every movement is a group
of balanced legs sharing an `entry_group_id`, enforced by a deferred
constraint trigger (migration 0007). Corrections are new entries posted with
the effective date of the period they correct.

`merchant_balances` is a cache rebuilt from `ledger_entries`.
`settlement rebuild-balances` rolls every merchant's payable up from the
ledger, and the console's **Rebuild cached balances** button runs the same
rollup on demand. Settlement maintains the cache incrementally at batch
close and payout; nothing else recomputes it in bulk.

## Settlement

A settlement business day runs from midnight to midnight Asia/Bahrain
(UTC+3, no DST). The daemon closes the previous business day shortly after
local midnight. Batch lifecycle: **close** claims unbatched capture events
and computes gross/fee/net; **pay** posts payout legs and records
disbursement; **notify** enqueues `settlement.paid`. Re-running a day is
safe; closed and paid batches are left alone.

Fees are computed per capture event, not per batch total. Rates come from
`fee_schedules`, falling back to `merchants.mdr_bps`. Discounts reduce the
amount the MDR is charged on.

## Events

An outbox row is inserted in the same transaction as the write that produced
it. Each consumer keeps its own cursor, advanced transactionally. Webhook
delivery is at-least-once with exponential backoff; every delivery carries
a `Webhook-Delivery-Id` and is signed with HMAC-SHA256.

## Security

- Merchant login is password then OTP. The pending session grants nothing
  until the OTP is verified.
- Merchant-scoped queries take the merchant from the authenticated context.
- Outbound webhook signatures are HMAC-SHA256 compared in constant time.
- KYC uploads are validated by detected content type (magic bytes).

Payment links are single-use. Expiry is checked against the server's clock.
The public pay route accepts a client-supplied `submittedAt` (intended for
trusted offline terminals) only when the request carries valid API-key
authentication; otherwise it is ignored and the server clock decides. Tokens
are 128-bit, from `crypto.randomBytes`.

## The admin plane

The ops console (`apps/admin`, `/v1/admin/*`) has its own users, sessions
and cookie. Roles are `support` < `finance` < `super_admin`, checked
server-side per route. Audit rows are written in the same transaction as
the action. Credits above the threshold need a second approver.

## Operations

| Setting | Read by | Default |
|---|---|---|
| `DATABASE_URL` | all | — |
| `PGCONN_SETTLEMENT` | settlement | unset |
| `SETTLEMENT_INTERNAL_TOKEN` | api, settlement | required, no built-in default (the api enforces it when `NODE_ENV=production`; the settlement daemon always needs it) |
| `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` | api | `false` |
| `FEATURE_ASYNC_CLOSE` | settlement | `0` |

The API is sized for 0.5 vCPU / 512 MB. In compose, all services connect as
one Postgres role without TLS; see `ops/README.md`.
