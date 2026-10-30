import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dateTime } from "../../format.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/**
 * `GET /v1/settlement/batches` — `requireMerchantAuth` with no role
 * restriction — a batch list is not as sensitive as the reconciliation
 * report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged — no instant conversion,
 * because there is no timezone in the column to convert against.
 */
/** Filters by batch_date, which is a Bahrain business date. */
export function SettlementBatchListPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<SettlementBatchStatus[]>([]);
  const [batches, setBatches] = useState<SettlementBatchDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every filter change (below). `load` captures the epoch at
  // dispatch and drops its result if a newer filter has since superseded it,
  // so a slow response for an old filter can't append wrong-filter rows or
  // clobber the current filter's cursor. Same "capture in the closure, guard
  // before setState" shape as SettlementBatchDetailPage's `cancelled` flag,
  // widened to also cover the imperative Load more path.
  const requestEpoch = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const epoch = requestEpoch.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to || undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        if (epoch !== requestEpoch.current) return;
        setBatches((previous) => (cursor ? [...previous, ...result.batches] : result.batches));
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (epoch !== requestEpoch.current) return;
        setError(describeError(err));
      } finally {
        if (epoch === requestEpoch.current) setLoading(false);
      }
    },
    [from, to, statuses],
  );

  useEffect(() => {
    requestEpoch.current += 1;
    void load(null);
  }, [load]);

  function toggleStatus(status: SettlementBatchStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>Settlement batches</h1>

      <fieldset className="dash-filters">
        <legend>Batch date</legend>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (exclusive)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {status}
          </label>
        ))}
      </fieldset>

      {error ? <p className="dash-error">{error}</p> : null}

      <table className="dash-table">
        <thead>
          <tr>
            <th>Batch date</th>
            <th>Status</th>
            <th>Gross</th>
            <th>Fee</th>
            <th>Net payout</th>
            <th>Closed</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link to={`/dashboard/settlement/${batch.id}`}>{batch.batchDate}</Link>
              </td>
              <td>
                <span className={`dash-status dash-status-${batch.status}`}>{batch.status}</span>
              </td>
              <td>{bhd(batch.grossFils)}</td>
              <td>{bhd(batch.feeFils)}</td>
              <td>{bhd(batch.netPayoutFils)}</td>
              <td>{dateTime(batch.closedAt)}</td>
              <td>{dateTime(batch.paidAt)}</td>
            </tr>
          ))}
          {batches.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>No settlement batches match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
