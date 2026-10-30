import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listPaymentLinks } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash, dateTime } from "../../format.js";
import type { PaymentLinkDto, PaymentLinkStatus } from "../../types.js";

/** The stored statuses plus `expired` (a stored `active` past expires_at), including `reserved` — the merchant-facing
 *  list deliberately exposes it distinctly rather than collapsing it into the
 *  public enum's `processing`, because a merchant needs to see that a link is
 *  mid-payment-attempt. */
const STATUSES: PaymentLinkStatus[] = ["active", "reserved", "paid", "canceled", "expired"];

const PAGE_SIZE = 25;

/**
 * Keyset paginated, newest first.
 * — FH
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
    <section>
      <h1>Payment links</h1>

      <RequireRole allow={["owner", "finance"]}>
        <p>
          <Link className="dash-button-link" to="/dashboard/payment-links/new">
            New payment link
          </Link>
        </p>
      </RequireRole>

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
            <th>Reference</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Expires</th>
            <th>Paid</th>
            <th>Canceled</th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.id}>
              <td>
                <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
              </td>
              <td>{dash(link.description)}</td>
              <td>{bhd(link.amountFils)}</td>
              <td>
                <span className={`dash-status dash-status-${link.status}`}>{link.status}</span>
              </td>
              <td>{dateTime(link.expiresAt)}</td>
              <td>{dateTime(link.paidAt)}</td>
              <td>{dateTime(link.canceledAt)}</td>
            </tr>
          ))}
          {links.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>No payment links match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
