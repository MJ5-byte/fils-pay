-- Acquirer callbacks are redelivered; the handler used to insert a new note
-- for every delivery (and the processed_events table the docs mention does
-- not exist). Collapse existing duplicates (keeping the first) and enforce
-- one note per callback_id.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
