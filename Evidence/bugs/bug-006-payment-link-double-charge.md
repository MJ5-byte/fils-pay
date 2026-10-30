# BUG-006 — Payment Link Double Charging via Concurrent Reservation Reclaim

## 1. Summary

The "lock" is a time-based reclaim, not a fence.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: RUNTIME REPRODUCED
- Category: Payments and payment links
- Affected Component: apps/api/src/paymentLinks/pay.ts
- Reachability: Reachable via concurrent checkout attempts
- Original Contributors / Sources: Incident 2026-05-14, EVID-020

## 3. Root Cause

Self-heal timeout is shorter than worst-case acquirer latency, and there is no `reservation_id` tying claim → capture → finalize.

## 4. Affected Files and Functions

- `apps/api/src/paymentLinks/pay.ts:65-76` — claim UPDATE reclaims a `reserved` row after `paymentLinkReservationTimeoutSeconds` (default 60s)
- `apps/api/src/paymentLinks/pay.ts:128-169` — authorize+capture run with **no** lock; finalize only checks `status = 'reserved'` with no reservation id. If finalize matches 0 rows after a successful capture, the handler still returns 200.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

The "lock" is a time-based reclaim, not a fence. A slow first payer still holds an in-flight authorize/capture when a second payer reclaims the same link. Both can capture. On capture failure the reservation is released but the authorization is not voided, so the link is payable again with an orphan hold at the acquirer.

`releaseReservation` (`pay.ts:188-191`) updates any row that is `reserved`, with no reservation id. The comment above it says the request only releases the reservation it holds. A failed attempt can therefore set a newer payer's reservation back to `active` while that payer is still in authorize/capture. The runtime reproduction (EVID-020) moved `reserved_at` backwards instead of waiting 60 seconds. Pool exhaustion is a weak way to hit that window: a checkout waits at most 5 seconds for a connection (`PG_POOL_CONNECTION_TIMEOUT_MS`, default 5000).

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/paymentLinks/pay.ts:65-76` — claim UPDATE reclaims a `reserved` row after `paymentLinkReservationTimeoutSeconds` (default 60s)
- `apps/api/src/paymentLinks/pay.ts:128-169` — authorize+capture run with **no** lock; finalize only checks `status = 'reserved'` with no reservation id. If finalize matches 0 rows after a successful capture, the handler still returns 200.

Technical details:
The "lock" is a time-based reclaim, not a fence. A slow first payer still holds an in-flight authorize/capture when a second payer reclaims the same link. Both can capture. On capture failure the reservation is released but the authorization is not voided, so the link is payable again with an orphan hold at the acquirer.

`releaseReservation` (`pay.ts:188-191`) updates any row that is `reserved`, with no reservation id. The comment above it says the request only releases the reservation it holds. A failed attempt can therefore set a newer payer's reservation back to `active` while that payer is still in authorize/capture. The runtime reproduction (EVID-020) moved `reserved_at` backwards instead of waiting 60 seconds. Pool exhaustion is a weak way to hit that window: a checkout waits at most 5 seconds for a connection (`PG_POOL_CONNECTION_TIMEOUT_MS`, default 5000).

## 9. Runtime Evidence

Runtime reproduction confirmed during investigation. See related runtime artifacts under `Evidence/runtime-artifacts/`.

## 10. Security / Financial / Functional Impact

Double card capture on a single-use link. One of the two payers can even be told "paid" when the link was already finalized by the other.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Incident 2026-05-14, EVID-020. Legacy file: `bug-7-payment-link-double-charge.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Issue a `reservation_id` at claim and require it on finalize. If finalize matches 0 rows after capture, void/refund that txn and return 409. Raise the timeout above acquirer RTT. On capture failure, void the authorization before releasing the row.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-7-payment-link-double-charge.md`

## 17. Evidence References

`apps/api/src/paymentLinks/pay.ts`, `bug-7-payment-link-double-charge.md`
