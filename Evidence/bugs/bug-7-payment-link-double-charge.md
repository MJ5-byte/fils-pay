# Bug 7 — One payment link can be charged twice (INCIDENT 2026-05-14)

**Severity:** Critical · **Area:** Payment links · **Clue:** Incident 2026-05-14 — *"The code comments say 'this IS reachable.'"*

## Where
- `apps/api/src/paymentLinks/pay.ts:65-76` — claim UPDATE reclaims a `reserved` row after `paymentLinkReservationTimeoutSeconds` (default 60s)
- `apps/api/src/paymentLinks/pay.ts:128-169` — authorize+capture run with **no** lock; finalize only checks `status = 'reserved'` with no reservation id. If finalize matches 0 rows after a successful capture, the handler still returns 200.

## What's wrong
The "lock" is a time-based reclaim, not a fence. A slow first payer still holds an in-flight authorize/capture when a second payer reclaims the same link. Both can capture. On capture failure the reservation is released but the authorization is not voided, so the link is payable again with an orphan hold at the acquirer.

`releaseReservation` (`pay.ts:188-191`) updates any row that is `reserved`, with no reservation id. The comment above it says the request only releases the reservation it holds. A failed attempt can therefore set a newer payer's reservation back to `active` while that payer is still in authorize/capture. The runtime reproduction (EVID-020) moved `reserved_at` backwards instead of waiting 60 seconds. Pool exhaustion is a weak way to hit that window: a checkout waits at most 5 seconds for a connection (`PG_POOL_CONNECTION_TIMEOUT_MS`, default 5000).

## Why
Self-heal timeout is shorter than worst-case acquirer latency, and there is no `reservation_id` tying claim → capture → finalize.

## What it breaks
Double card capture on a single-use link. One of the two payers can even be told "paid" when the link was already finalized by the other.

## Smallest fix
Issue a `reservation_id` at claim and require it on finalize. If finalize matches 0 rows after capture, void/refund that txn and return 409. Raise the timeout above acquirer RTT. On capture failure, void the authorization before releasing the row.
