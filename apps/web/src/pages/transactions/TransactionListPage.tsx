import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash, dateTime, dayStartIso, statusLabel } from "../../format.js";
import { classNames, pluralize, truncateMiddle } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param — nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 */
export function TransactionListPage() {
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box — the checkbox/date controls fire immediately,
  // since those are discrete choices, not a stream of keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Bumped on every filter change (below). `load` captures the epoch at
  // dispatch and drops its result if a newer filter has since superseded it,
  // so a slow response for an old filter can't overwrite the current rows.
  // Same request-epoch guard as SettlementBatchListPage.
  const requestEpoch = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const epoch = requestEpoch.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: dayStartIso(from),
          to: dayStartIso(to),
          search: search || undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        if (epoch !== requestEpoch.current) return;
        setTransactions((previous) =>
          cursor ? [...previous, ...result.transactions] : result.transactions,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (epoch !== requestEpoch.current) return;
        setError(describeError(err));
      } finally {
        if (epoch === requestEpoch.current) setLoading(false);
      }
    },
    [statuses, from, to, search],
  );

  useEffect(() => {
    requestEpoch.current += 1;
    void load(null);
  }, [load]);

  function toggleStatus(status: TransactionStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>Transactions</h1>

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

      <fieldset className="dash-filters">
        <legend>Filter</legend>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {/* Exclusive, because the endpoint's own predicate is
              `occurred_at < to` — labelled rather than quietly shifted by a
              day here, which would make this page and the API disagree about
              what a filter means. */}
          To (exclusive)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Search
          <input
            type="search"
            placeholder="Reference, acquirer reference, or transaction id"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
      </fieldset>

      {error ? <p className="dash-error">{error}</p> : null}

      <p>{pluralize(transactions.length, "transaction")} loaded</p>

      <table className="dash-table">
        <thead>
          <tr>
            <th>Occurred</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Authorized</th>
            <th>Captured</th>
            <th>Acquirer reference</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => (
            <tr key={txn.id}>
              <td>
                <Link to={`/dashboard/transactions/${txn.id}`}>{dateTime(txn.occurredAt)}</Link>
              </td>
              <td>{dash(txn.reference)}</td>
              <td>
                <span className={classNames("dash-status", `dash-status-${txn.status}`)}>{statusLabel(txn.status)}</span>
              </td>
              <td>{bhd(txn.amountFils)}</td>
              <td>{bhd(txn.capturedFils)}</td>
              <td>
                <code>{truncateMiddle(txn.acquirerReference, 20)}</code>
              </td>
            </tr>
          ))}
          {transactions.length === 0 && !loading ? (
            <tr>
              <td colSpan={6}>No transactions match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
