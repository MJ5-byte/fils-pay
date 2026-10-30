import {
  ColumnHead,
  IconBan,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoins,
  IconDoc,
  IconHash,
  PageHeader,
  SkeletonRows,
} from "@filspay/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pagination } from "../../components/Pagination.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconLinks, IconPlus } from "../../components/icons.js";
import { dash, dateTime } from "../../format.js";
import { classNames } from "../../utils/helpers.js";
import type { PaymentLinkDto, PaymentLinkStatus } from "../../types.js";

/** The stored statuses plus expired, including reserved. The merchant-facing
 *  list deliberately exposes it distinctly rather than collapsing it into the
 *  public enum's `processing`, because a merchant needs to see that a link is
 *  mid-payment-attempt. */
const STATUSES: PaymentLinkStatus[] = ["active", "reserved", "paid", "canceled", "expired"];

const PAGE_SIZE = 25;

/** The stored enum value as a human label, underscore gone and Title Cased,
 *  the same shape every list filter uses. */
function statusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Keyset paginated, newest first.
 * FH
 */
export function PaymentLinkListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [statuses, setStatuses] = useState<PaymentLinkStatus[]>([]);
  const [links, setLinks] = useState<PaymentLinkDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every filter change (below). `load` captures the epoch at
  // dispatch and drops its result if a newer filter has since superseded it,
  // so a slow response for an old filter can't overwrite the current rows.
  // Same request-epoch guard as SettlementBatchListPage.
  const requestEpoch = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      if (!merchantId) return;
      const epoch = requestEpoch.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listPaymentLinks(merchantId, {
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        if (epoch !== requestEpoch.current) return;
        setLinks((previous) => (cursor ? [...previous, ...result.paymentLinks] : result.paymentLinks));
        setNextCursor(result.nextCursor);
      } catch (err) {
        if (epoch !== requestEpoch.current) return;
        setError(describeError(err));
      } finally {
        if (epoch === requestEpoch.current) setLoading(false);
      }
    },
    [merchantId, statuses],
  );

  useEffect(() => {
    requestEpoch.current += 1;
    void load(null);
  }, [load]);

  function toggleStatus(status: PaymentLinkStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Payment links" lede={<> Reusable checkout links you can share, track and settle. </>} />
      <div className="fp-list-card">
        <div className="dash-toolbar">
          <div>
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
          <RequireRole allow={["owner", "finance"]}>
            <Link className="dash-button dash-button-primary" to="/dashboard/payment-links/new">
              <IconPlus /> New payment link
            </Link>
          </RequireRole>
        </div>

        {error ? <p className="dash-error">{error}</p> : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconHash}>Reference</ColumnHead></th>
                <th><ColumnHead icon={IconDoc}>Description</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Amount</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th><ColumnHead icon={IconCalendar}>Expires</ColumnHead></th>
                <th><ColumnHead icon={IconCheck}>Paid</ColumnHead></th>
                <th><ColumnHead icon={IconBan}>Canceled</ColumnHead></th>
              </tr>
            </thead>
            {loading && links.length === 0 ? <SkeletonRows rows={5} columns={7} /> : <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td>
                    <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
                  </td>
                  <td>{dash(link.description)}</td>
                  <td className="dash-num">
                    <Money fils={link.amountFils} />
                  </td>
                  <td>
                    <StatusBadge status={link.status} />
                  </td>
                  <td>{dateTime(link.expiresAt)}</td>
                  <td>{dateTime(link.paidAt)}</td>
                  <td>{dateTime(link.canceledAt)}</td>
                </tr>
              ))}
              {links.length === 0 && !loading ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={7}>
                    <EmptyState icon={IconLinks}>No payment links match these filters.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{links.length === 0 ? "0 results" : `Showing 1 to ${links.length}${nextCursor ? ", more available" : ""}`}</span>
          <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
        </div>
      </div>
    </section>
  );
}
