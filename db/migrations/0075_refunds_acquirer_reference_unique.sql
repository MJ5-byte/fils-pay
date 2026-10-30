-- Give every refund a unique reference so a retried or re-posted refund
-- cannot create a second refund row and move the money twice (BHA-123).
--
-- 0042 made refunds.acquirer_reference NOT NULL but left it un-unique, so a
-- duplicate reference (a client retry with no idempotency anchor, or a
-- re-import of the same acquirer refund) inserted a second refund and a
-- second fee reversal. Each refund now carries the reference the acquirer
-- issues for that refund (see apps/api/src/acquirer/simulator.ts), and this
-- constraint lets the refund insert collapse a duplicate with
-- ON CONFLICT instead of double-posting.
--
-- Additive: a new UNIQUE constraint only. No column, row or existing
-- constraint is dropped or changed. refunds held no rows before this, so the
-- constraint validates immediately; if an environment already has refunds
-- with a duplicate acquirer_reference, this will fail loudly rather than
-- silently accept it (competition rule 3: human sign-off required).

ALTER TABLE refunds
    ADD CONSTRAINT refunds_acquirer_reference_key UNIQUE (acquirer_reference);
