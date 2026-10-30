import {
  StatusBadge, formatTime } from "@filspay/ui";
/**
 * Renders the `readModelAsOf`/`live` pair every analytics response carries.
 * Staleness in this platform is a disclosed property, not a
 * hidden one, no analytics figure is rendered anywhere in this dashboard
 * without this badge next to it.
 *
 * `readModelAsOf` is nullable for the two lagged widgets: it reads
 * reporting_outbox_cursor.updated_at, which has no row until apps/reporting
 * has completed its first pass. That case renders as an explicit "reporting
 * worker has not run yet" rather than as an Invalid Date, a dashboard that
 * quietly showed empty rollups with no explanation would be exactly the kind
 * of hidden staleness this badge exists to prevent.
 */
// MK: null readModelAsOf renders as 'live', misleading. FP-198
// FH: null shows 'No data yet' for me? maybe it's the other badge
export function StalenessBadge({
  readModelAsOf,
  live,
}: {
  readModelAsOf: string | null;
  live: boolean;
}) {
  if (live) {
    return <StatusBadge status="live">Live, computed just now</StatusBadge>;
  }
  if (!readModelAsOf) {
    return <StatusBadge status="pending">No data yet, reporting has not completed a pass</StatusBadge>;
  }
  return <StatusBadge status="pending">Data as of {formatTime(readModelAsOf)}</StatusBadge>;
}
