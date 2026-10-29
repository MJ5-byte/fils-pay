const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * Yesterday's Asia/Bahrain calendar date (YYYY-MM-DD), the business day
 * settlement batches are keyed on (ADR-0003), whatever the browser's own
 * timezone. Same fixed-offset technique as apps/api's
 * `todayBahrainDateString` and apps/web's reconciliation default range:
 * Bahrain has no DST since 1972, so +3h is exact.
 */
export function yesterdayIso(now: number = Date.now()): string {
  return new Date(now + BAHRAIN_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}
