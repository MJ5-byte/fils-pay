-- One payout-rail disbursement per settlement batch.
--
-- The dispatcher's settlement.paid pre-delivery effect
-- (apps/api/src/webhooks/payoutDisbursement.ts) can legitimately run more
-- than once for the same batch — two concurrent dispatch passes selecting
-- the same due row, or a replay of an already-sent delivery (a replay row
-- starts at attempt_count 0, so the dispatcher re-runs the effect). The
-- effect's INSERT ... ON CONFLICT (settlement_batch_id) DO NOTHING targets
-- this index, turning any duplicate run into a no-op instead of a second
-- disbursement record (cf. the 20 Aug double-disbursement incident in
-- docs/ADMIN.md). Matches migration 0057's own "one row per paid batch"
-- intent.
CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);
