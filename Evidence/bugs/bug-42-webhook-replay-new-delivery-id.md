# Bug 42 — Webhook replay mints a new delivery id

**Severity:** Medium · **Area:** Webhooks · **Clue:** Architecture — every delivery carries a `Webhook-Delivery-Id`; incident 2026-08-21

## Where
- `apps/api/src/webhooks/replay.ts:24-61` — `newDeliveryEventId = randomUUID()`, payload `id` overwritten, new row with `attempt_count = 0`

## What's wrong
Receivers that dedupe on `Webhook-Delivery-Id` or body `id` treat a replay as a brand-new event. Because `attempt_count === 0`, Bug 41's disbursement effect fires again.

## Why
Replay was implemented as "insert a new delivery" instead of "resend the same bytes with a new timestamp/signature."

## What it breaks
Duplicate merchant processing of payouts, captures, etc.

## Smallest fix
Reuse the original `delivery_event_id` (new signature/timestamp only), or skip `PRE_DELIVERY_EFFECTS` when `replay_of_delivery_id IS NOT NULL`.
