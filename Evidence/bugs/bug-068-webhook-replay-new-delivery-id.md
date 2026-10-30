# BUG-068 — Webhook Replay Mints New Delivery ID Causing Receivers to Treat as New Event

## 1. Summary

Receivers that dedupe on `Webhook-Delivery-Id` or body `id` treat a replay as a brand-new event.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/replay.ts
- Reachability: Reachable on manual or automatic webhook replay
- Original Contributors / Sources: ARCHITECTURE, incident 2026-08-21

## 3. Root Cause

Replay was implemented as "insert a new delivery" instead of "resend the same bytes with a new timestamp/signature."

## 4. Affected Files and Functions

- `apps/api/src/webhooks/replay.ts:24-61` — `newDeliveryEventId = randomUUID()`, payload `id` overwritten, new row with `attempt_count = 0`

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Receivers that dedupe on `Webhook-Delivery-Id` or body `id` treat a replay as a brand-new event. Because `attempt_count === 0`, Bug 41's disbursement effect fires again.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/replay.ts:24-61` — `newDeliveryEventId = randomUUID()`, payload `id` overwritten, new row with `attempt_count = 0`

Technical details:
Receivers that dedupe on `Webhook-Delivery-Id` or body `id` treat a replay as a brand-new event. Because `attempt_count === 0`, Bug 41's disbursement effect fires again.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Duplicate merchant processing of payouts, captures, etc.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ARCHITECTURE, incident 2026-08-21. Legacy file: `bug-42-webhook-replay-new-delivery-id.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Reuse the original `delivery_event_id` (new signature/timestamp only), or skip `PRE_DELIVERY_EFFECTS` when `replay_of_delivery_id IS NOT NULL`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-42-webhook-replay-new-delivery-id.md`

## 17. Evidence References

`apps/api/src/webhooks/replay.ts`, `bug-42-webhook-replay-new-delivery-id.md`
