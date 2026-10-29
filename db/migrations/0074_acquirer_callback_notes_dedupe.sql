-- FP-201 (reopened): the acquirer redelivers a callback with the same
-- callback_id, and nothing on our side dropped the redelivery — the
-- processed_events table and FP-238's index referenced in 0051 were never
-- created. Collapse existing redeliveries to the first row received, then
-- make callback_id unique so applyAcquirerCallback's ON CONFLICT drops
-- future ones.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
