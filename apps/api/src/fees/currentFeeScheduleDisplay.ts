import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current negotiated fee schedule for display on the
 * admin merchant-detail page. Same resolution as the billing path
 * (feeSchedule.ts): the newest row whose effective_from has already
 * arrived, ties on effective_from broken by created_at DESC — so a
 * backdated correction row (older effective_from, later created_at) can
 * never win the display over the rate that actually applies now.
 */
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
