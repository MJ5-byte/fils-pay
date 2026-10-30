-- Incident 2026-08-21: shops got two "your payout is on the way" webhooks for
-- one payout. EnqueuePayoutNotifications checks NOT EXISTS and then INSERTs as
-- two separate statements, so the daemon tick and a CLI run-batch that overlap
-- both see "not notified yet" and both insert. Only the database can make that
-- check-and-insert atomic: allow one settlement.paid event per batch.
--
-- Existing duplicates may already have webhook_deliveries pointing at them
-- (FK), so they can't be deleted. Relabel every copy after the first; no
-- endpoint subscribes to the new type, so nothing more is sent for them.

UPDATE outbox_events e
   SET event_type = 'settlement.paid.duplicate'
  FROM outbox_events first
 WHERE e.event_type = 'settlement.paid'
   AND first.event_type = 'settlement.paid'
   AND first.aggregate_id = e.aggregate_id
   AND first.id < e.id;

CREATE UNIQUE INDEX uq_outbox_settlement_paid_once
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';
