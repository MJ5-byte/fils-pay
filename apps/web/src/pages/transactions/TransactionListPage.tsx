import {
  ColumnFilter,
  ColumnHead,
  FilterOptionList,
  IconCalendar,
  IconClock,
  IconCoins,
  IconHash,
  PageHeader,
  SkeletonRows,
} from "@filspay/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconSearch } from "../../components/icons.js";
import { dash, dateTime, dayStartIso } from "../../format.js";
import { pluralize, truncateMiddle } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";
import { DatePicker } from "../../components/DatePicker.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

/** The server enum value turned into a human label, Title Cased, with the
 *  machine underscore gone. No label map, so a value outside this set still
 *  reads as its own Title Cased words rather than a raw key. */
function statusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param: nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 */
export function TransactionListPage() {
  const navigate = useNavigate();
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box: the chip/date controls fire immediately,
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
    <section className="fp-page fp-stagger">
      <PageHeader title="Transactions" lede={<> Every authorization, capture, void and refund on your account. </>} />

      <div className="fp-list-card">
        <div className="dash-toolbar">
          <div className="dash-toolbar-grow">
            <span className="dash-field-label">Search</span>
            <label className="fp-search"><IconSearch />
              <input
                type="search"
                placeholder="Reference or transaction ID"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}

              />
            </label>
          </div>
        </div>

        {error ? <p className="dash-error">{error}</p> : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>
                  <ColumnFilter icon={IconCalendar} label="Occurred" active={from !== "" || to !== ""}>
                    <label>
                      From
                      <DatePicker value={from} onChange={setFrom} />
                    </label>
                    <label>
                      {/* Exclusive, because the endpoint's own predicate is
                        `occurred_at < to`, labelled rather than quietly shifted by a
                        day here, which would make this page and the API disagree about
                        what a filter means. */}
                      To (exclusive)
                      <DatePicker value={to} onChange={setTo} />
                    </label>
                  </ColumnFilter>
                </th>
                <th><ColumnHead icon={IconHash}>Reference</ColumnHead></th>
                <th>
                  <ColumnFilter icon={IconClock} label="Status" active={statuses.length > 0}>
                    <FilterOptionList
                      options={STATUSES.map((status) => ({ value: status, label: <StatusBadge status={status} /> }))}
                      selected={statuses}
                      onToggle={toggleStatus}
                    />
                  </ColumnFilter>
                </th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Authorized</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Captured</ColumnHead></th>
                <th><ColumnHead icon={IconHash}>Acquirer Reference</ColumnHead></th>
              </tr>
            </thead>
            {loading && transactions.length === 0 ? <SkeletonRows rows={5} columns={6} /> : <tbody>
              {transactions.map((txn) => (
                <tr
                  key={txn.id}
                  className="dash-row-link"
                  onClick={(event) => {
                    // The date link handles its own click and keyboard; a drag
                    // to select a reference must not navigate either.
                    if (event.target instanceof Element && event.target.closest("a")) return;
                    if (window.getSelection()?.toString()) return;
                    navigate(`/dashboard/transactions/${txn.id}`);
                  }}
                >
                  <td>
                    <Link to={`/dashboard/transactions/${txn.id}`}>{dateTime(txn.occurredAt)}</Link>
                  </td>
                  <td>{dash(txn.reference)}</td>
                  <td>
                    <StatusBadge status={txn.status} />
                  </td>
                  <td className="dash-num">
                    <Money fils={txn.amountFils} />
                  </td>
                  <td className="dash-num">
                    <Money fils={txn.capturedFils} />
                  </td>
                  <td>
                    <code>{truncateMiddle(txn.acquirerReference, 20)}</code>
                  </td>
                </tr>
              ))}
              {transactions.length === 0 && !loading ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={6}>
                    <EmptyState icon={IconSearch}>No transactions match these filters.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{transactions.length === 0 ? "0 results" : `Showing 1 to ${transactions.length}${nextCursor ? ", more available" : ""}`}</span>
          <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
        </div>
      </div>
    </section>
  );
}
