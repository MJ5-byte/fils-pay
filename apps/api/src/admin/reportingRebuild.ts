import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const trendResult = await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
       FROM settlement_batches`,
  );

  const volumeResult = await client.query(
    `INSERT INTO merchant_daily_volume
        (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count,
         refund_count, refund_gross_fils, last_updated_at)
     SELECT t.merchant_id,
            (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
            COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')),
            COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0),
            COUNT(*) FILTER (WHERE te.event_type = 'voided'),
            -- refund events carry a negative amount (0044); the rollup stores it positive
            COUNT(*) FILTER (WHERE te.event_type IN ('refunded', 'refund_partial')),
            COALESCE(-SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('refunded', 'refund_partial')), 0),
            now()
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE te.event_type IN ('captured', 'partially_captured', 'voided', 'refunded', 'refund_partial')
      GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date`,
  );

  return { volumeRows: volumeResult.rowCount ?? 0, trendRows: trendResult.rowCount ?? 0 };
}
