-- Three money columns are guarded only by the application, so a bad write
-- (or a future bug) is stored silently and surfaces later as a wrong payout:
--   * transactions.refunded_fils (0043) is checked >= 0 only, so a refund
--     total can exceed what was captured. (BHA-122)
--   * merchants.mdr_bps (0002) has no CHECK at all, so a negative or absurd
--     rate prices settlements nonsensically. Same 0..10000 range as
--     fee_schedules (0048, 0077). (BHA-117)
--   * settlement_batches.net_payout_fils (0006) has no sign check. CloseBatch
--     never writes a negative net and PayoutBatch refuses one, so this only
--     makes the database agree with the code. gross_fils and fee_fils are
--     left alone: a carried-forward refund can reverse more fee than the
--     batch holds, so a negative fee_fils is a legitimate value. (BHA-119)
--
-- Additive only: each is a new named CHECK, with no rewrite of existing
-- rows. The seeded data already satisfies all three (no violating rows).
ALTER TABLE transactions
    ADD CONSTRAINT transactions_refunded_within_captured
        CHECK (refunded_fils <= captured_fils);

ALTER TABLE merchants
    ADD CONSTRAINT merchants_mdr_bps_range
        CHECK (mdr_bps BETWEEN 0 AND 10000);

ALTER TABLE settlement_batches
    ADD CONSTRAINT settlement_batches_net_payout_non_negative
        CHECK (net_payout_fils >= 0);
