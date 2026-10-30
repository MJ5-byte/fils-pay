-- lifetime_net_payout_monitoring_estimate was REAL (float4): exact only up
-- to 2^24 fils (~16,777 BD), so it drifted for high-volume merchants
-- (finance memo). Money is integer fils (ADR-0001). Convert to BIGINT and
-- recompute from paid batches, since the drifted values can't be trusted.

ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE((
       SELECT sum(sb.net_payout_fils)
         FROM settlement_batches sb
        WHERE sb.merchant_id = m.id AND sb.status = 'paid'
   ), 0);
