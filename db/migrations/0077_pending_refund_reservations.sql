-- A pending amount is durable before contacting the processor. A crash or
-- unknown processor result must not restore another request's refund budget.
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed'));
CREATE INDEX idx_refunds_pending_transaction ON refunds (transaction_id)
  WHERE status = 'pending';
