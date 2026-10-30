-- Batch detail counts, MDR recalculation and the payout notifier's every-tick
-- NOT EXISTS looked rows up by settlement batch with no usable index. Additive only.
CREATE INDEX IF NOT EXISTS idx_transaction_events_settlement_batch_id
    ON transaction_events (settlement_batch_id);

CREATE INDEX IF NOT EXISTS idx_refunds_settlement_batch_id
    ON refunds (settlement_batch_id);

CREATE INDEX IF NOT EXISTS idx_outbox_events_settlement_paid_aggregate
    ON outbox_events (aggregate_id)
    WHERE event_type = 'settlement.paid';
