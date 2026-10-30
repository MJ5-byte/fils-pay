-- The per-insert ledger balance trigger and per-capture/refund transaction
-- lookups had no indexes and scanned whole tables. Additive only.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group_id
    ON ledger_entries (entry_group_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_id
    ON ledger_entries (transaction_id);

CREATE INDEX IF NOT EXISTS idx_holds_transaction_id
    ON holds (transaction_id);
