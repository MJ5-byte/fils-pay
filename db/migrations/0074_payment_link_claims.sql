-- Durable payer ownership survives a process crash and cannot be stolen by
-- waiting for a lease timeout. Never persist raw cards or idempotency keys.
ALTER TABLE payment_links
  ADD COLUMN reservation_id UUID,
  ADD COLUMN payment_key_hash TEXT,
  ADD COLUMN payment_request_hash TEXT;
-- Legacy reserved links without ownership remain processing. Reconcile/void
-- their transactions before explicitly releasing them; do not guess ownership.
