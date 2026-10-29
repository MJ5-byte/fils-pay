-- Redelivery dedupe for acquirer callbacks (FP-201). 0051 deliberately did
-- not make callback_id globally unique, because the sandbox acquirer reuses
-- callback_ids across transactions — a redelivered verdict is the SAME
-- (transaction_id, callback_id) pair, a legitimately different callback is a
-- different pair. So the unique scope is the pair, and an idempotent insert
-- (ON CONFLICT DO NOTHING) drops only genuine redeliveries.
CREATE UNIQUE INDEX uq_acquirer_callback_notes_txn_cb
    ON acquirer_callback_notes (transaction_id, callback_id);