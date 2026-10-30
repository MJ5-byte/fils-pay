-- fee_schedules.mdr_bps (0048) is checked only for mdr_bps >= 0, with no
-- upper bound, so a fat-fingered rate such as 25000 bps (250%) is accepted
-- and then prices settlements. merchants.negotiated_discount_bps (0047)
-- already caps a basis-points rate at 10000 (100%); match that ceiling here.
--
-- Additive: this adds a second, named CHECK alongside the existing >= 0 one
-- rather than altering it. Every fee_schedules row today holds a normal rate
-- (the seed uses 165 to 245 bps), so ADD CONSTRAINT validates the existing
-- data without a rewrite. (BHA-118)
ALTER TABLE fee_schedules
    ADD CONSTRAINT fee_schedules_mdr_bps_upper_bound
        CHECK (mdr_bps <= 10000);
