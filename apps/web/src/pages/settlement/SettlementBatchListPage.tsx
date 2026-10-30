import {
  ColumnHead,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoins,
  IconPercent,
  IconWallet,
  PageHeader,
  SkeletonRows, formatBusinessDate } from "@filspay/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconSettlement } from "../../components/icons.js";
import { dateTime } from "../../format.js";
import { classNames } from "../../utils/helpers.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";
import { DatePicker } from "../../components/DatePicker.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/** The stored enum value as a human label, underscore gone and Title Cased. */
function statusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * `GET /v1/settlement/batches`, `requireMerchantAuth` with no role
 * restriction: a batch list is not as sensitive as the reconciliation report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged, no instant conversion,
 * because there is no timezone in the column to convert against. It is a
 * Bahrain business date.
 */
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
    <section className="fp-page fp-stagger">
      <PageHeader title="Settlement batches" lede={<> Daily payouts to your account, with the gross, fee and net on each. </>} />

      <div className="fp-list-card">
        <div className="dash-toolbar">
          <label>
            From
            <DatePicker value={from} onChange={setFrom} />
          </label>
          <label>
            To (exclusive)
            <DatePicker value={to} onChange={setTo} />
          </label>
        </div>

        <div className="fp-filter-block">
          <span className="dash-field-label">Status</span>
          <div className="dash-chips">
            {STATUSES.map((status) => (
              <label
                key={status}
                className={classNames("dash-chip", statuses.includes(status) && "dash-chip-on")}
              >
                <input
                  type="checkbox"
                  checked={statuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                <StatusBadge status={status} />
              </label>
            ))}
          </div>
        </div>

        {error ? <p className="dash-error">{error}</p> : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconCalendar}>Batch Date</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Gross</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconPercent} align="right">Fee</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconWallet} align="right">Net Payout</ColumnHead></th>
                <th><ColumnHead icon={IconCheck}>Closed</ColumnHead></th>
                <th><ColumnHead icon={IconCheck}>Paid</ColumnHead></th>
              </tr>
            </thead>
            {loading && batches.length === 0 ? <SkeletonRows rows={5} columns={7} /> : <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td>
                    <Link to={`/dashboard/settlement/${batch.id}`}>{formatBusinessDate(batch.batchDate)}</Link>
                  </td>
                  <td>
                    <StatusBadge status={batch.status} />
                  </td>
                  <td className="dash-num">
                    <Money fils={batch.grossFils} />
                  </td>
                  <td className="dash-num">
                    <Money fils={batch.feeFils} />
                  </td>
                  <td className="dash-num">
                    <Money fils={batch.netPayoutFils} />
                  </td>
                  <td>{dateTime(batch.closedAt)}</td>
                  <td>{dateTime(batch.paidAt)}</td>
                </tr>
              ))}
              {batches.length === 0 && !loading ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={7}>
                    <EmptyState icon={IconSettlement}>No settlement batches match these filters.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{batches.length === 0 ? "0 results" : `Showing 1 to ${batches.length}${nextCursor ? ", more available" : ""}`}</span>
          <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
        </div>
      </div>
    </section>
  );
}
