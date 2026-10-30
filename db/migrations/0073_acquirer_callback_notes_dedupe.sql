-- BHA-16: the acquirer redelivers the same callback_id. This unique index
-- makes the ON CONFLICT DO NOTHING insert dedupe safely under concurrency.
-- Human approval is required before this additive migration runs in shared/hosted DBs.

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id ON acquirer_callback_notes (callback_id);
