-- FP-212 / FP-300: refunds reduce the payout of the batch whose business day
-- they occurred in. net_payout_fils = gross_fils - fee_fils - refunded_fils
-- + fee_reversed_fils. Both new columns are positive magnitudes.

ALTER TABLE settlement_batches
    ADD COLUMN refunded_fils     BIGINT NOT NULL DEFAULT 0 CHECK (refunded_fils >= 0),
    ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (fee_reversed_fils >= 0);
