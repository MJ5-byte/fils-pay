-- Payment links: a reservation token identifies WHICH pay attempt holds a
-- link. Without it, a slow attempt whose reservation timed out could finish
-- after a second buyer had re-claimed (and paid) the same link, and both
-- cards would stay charged. Finalize and release now match on the token.
-- Also lets automated reversals (actor 'system') be attributed on refunds.

ALTER TABLE payment_links ADD COLUMN reservation_token UUID;

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_created_by_type_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_created_by_type_check
    CHECK (created_by_type IN ('merchant_session', 'merchant_api_key', 'system'));
