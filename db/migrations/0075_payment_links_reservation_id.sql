-- Incident 2026-05-14: a pay attempt slower than the reservation timeout
-- had its reservation re-claimed by a second buyer, and both were charged.
-- Each claim now carries its own id, so a pay attempt can tell whether the
-- reservation it is acting under is still its own (see paymentLinks/pay.ts).

ALTER TABLE payment_links ADD COLUMN reservation_id UUID;
