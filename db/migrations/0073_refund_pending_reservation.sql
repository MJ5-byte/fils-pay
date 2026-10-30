-- Refund reservations (FP-209 / FP-300).
--
-- processRefund used to read the refundable amount, release the row, call the
-- acquirer and only then journal the refund, so two simultaneous refunds
-- could both pass validation and both pay out. A refund now reserves its
-- amount up front: a 'pending' row is inserted under the transaction's row
-- lock, counted against the refundable ceiling by every later request, then
-- settled to 'succeeded' or 'failed' once the acquirer has answered.

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('pending', 'succeeded', 'failed'));

-- A pending refund has no acquirer reference until the acquirer answers.
ALTER TABLE refunds ALTER COLUMN acquirer_reference DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_pending
    ON refunds (transaction_id)
    WHERE status = 'pending';
