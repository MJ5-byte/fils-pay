-- B17: settlement.paid is inserted by two paths whose NOT EXISTS scans are
-- not race-safe (PayoutBatch's own insert and EnqueuePayoutNotifications) —
-- two processes can both pass the scan under READ COMMITTED and enqueue a
-- duplicate, which would then be dispatched twice. Scope the dedup to
-- settlement.paid ONLY: a global (event_type, aggregate_id) unique index
-- would wrongly reject legitimate second events per transaction (partial
-- captures emit transaction.captured again; partial refunds emit
-- refund.succeeded again).
--
-- Deduplicate first so the index can be created even against a database
-- that already collected duplicates: keep the oldest row per paid batch.

DELETE FROM outbox_events a
 USING outbox_events b
 WHERE a.event_type = 'settlement.paid'
   AND b.event_type = 'settlement.paid'
   AND a.aggregate_id = b.aggregate_id
   AND a.id > b.id;

CREATE UNIQUE INDEX uq_outbox_events_settlement_paid
    ON outbox_events (aggregate_id) WHERE event_type = 'settlement.paid';