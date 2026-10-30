import {
  ColumnFilter,
  ColumnHead,
  FilterOptionList,
  IconActivity,
  IconCalendar,
  IconClock,
  IconDoc,
  IconHash,
  PageHeader,
  Skeleton,
  SkeletonRows,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listDeliveries, listWebhookEndpoints, replayDelivery } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { Pagination } from "../../components/Pagination.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconArrowLeft, IconReplay, IconWebhooks } from "../../components/icons.js";
import { dash, dateTime } from "../../format.js";
import type { WebhookDeliveryDto, WebhookDeliveryStatus, WebhookEndpointDto } from "../../types.js";

/** The stored enum value as a human label, underscore gone and Title Cased. */
function statusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** `webhook_deliveries.status`' four CHECK values. Note the dispatcher only
 *  ever writes `succeeded`/`exhausted`, a row awaiting its next attempt
 *  stays `pending`, so `failed` is present in the schema but currently
 *  unwritten. Offered as a filter anyway, since the filter's job is to match
 *  the column, not the dispatcher's current habits. */
const DELIVERY_STATUSES: WebhookDeliveryStatus[] = ["pending", "succeeded", "failed", "exhausted"];

const PAGE_SIZE = 25;

export function WebhookEndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [endpoint, setEndpoint] = useState<WebhookEndpointDto | null>(null);
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [statuses, setStatuses] = useState<WebhookDeliveryStatus[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Same "no single-resource GET" situation as payment links: the API has
  // the endpoint list and the deliveries sub-resource, but no
  // `GET .../webhook-endpoints/:id`. Merchants have a handful of endpoints,
  // not hundreds, so finding the row in the list is exact in practice here –
  // unlike the payment-link case, where it can genuinely miss.
  const loadEndpoint = useCallback(async () => {
    if (!merchantId || !id) return;
    setError(null);
    try {
      const all = await listWebhookEndpoints(merchantId);
      const found = all.find((candidate) => candidate.id === id) ?? null;
      setEndpoint(found);
      setEndpointMissing(found === null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId, id]);

  const loadDeliveries = useCallback(
    async (cursor: string | null) => {
      if (!merchantId || !id) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listDeliveries(merchantId, id, {
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setDeliveries((previous) =>
          cursor ? [...previous, ...result.deliveries] : result.deliveries,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [merchantId, id, statuses],
  );

  useEffect(() => {
    void loadEndpoint();
  }, [loadEndpoint]);

  useEffect(() => {
    void loadDeliveries(null);
  }, [loadDeliveries]);

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  // FH: fast double click fires replay twice -> dup deliveries + the memory leak
  // busyId disables the button, cant double click, am
  async function handleReplay(delivery: WebhookDeliveryDto): Promise<void> {
    if (!merchantId || !id) return;
    setBusyId(delivery.id);
    setError(null);
    try {
      await replayDelivery(merchantId, id, delivery.id);
      // The replay is a brand-new `pending` row, newest-first, so refetch from
      // the top rather than appending to what's on screen.
      await loadDeliveries(null);
    } catch (err) {
      // `409 endpoint_disabled` is a real race: someone disabled the endpoint
      // between this page loading and the click.
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (endpointMissing) {
    return <section className="fp-page fp-stagger">
      <PageHeader title="Webhook endpoint" back={<Link to="/dashboard/webhooks"><IconArrowLeft /> Back</Link>} />
      <div className="dash-card"><EmptyState icon={IconWebhooks}>No webhook endpoint with this id exists on your account.</EmptyState></div>
    </section>;
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Webhook endpoint" status={endpoint ? <StatusBadge status={endpoint.status} /> : null} back={<Link to="/dashboard/webhooks"><IconArrowLeft /> Back</Link>} />

      {endpoint ? (
        <div className="dash-card">
          <dl className="dash-dl">
            <div className="dash-fact"><dt>URL</dt>
              <dd>{endpoint.url}</dd></div>
            <div className="dash-fact"><dt>Secret prefix</dt>
              <dd>
                <code>{endpoint.secretPrefix}</code>
              </dd></div>
            <div className="dash-fact"><dt>Created at</dt>
              <dd>{dateTime(endpoint.createdAt)}</dd></div>
            <div className="dash-fact"><dt>Updated at</dt>
              <dd>{dateTime(endpoint.updatedAt)}</dd></div>
          </dl>
        </div>
      ) : !error ? <div className="fp-loading"><Skeleton height={120} /></div> : null}

      <div className="fp-list-card">
        <div className="dash-card-head"><h2 className="dash-card-title">Delivery log</h2></div>

        {error ? <p className="dash-error">{error}</p> : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
                <th><ColumnHead icon={IconActivity}>Event</ColumnHead></th>
                <th>
                  <ColumnFilter icon={IconClock} label="Status" active={statuses.length > 0}>
                    <FilterOptionList
                      options={DELIVERY_STATUSES.map((status) => ({ value: status, label: <StatusBadge status={status} /> }))}
                      selected={statuses}
                      onToggle={toggleStatus}
                    />
                  </ColumnFilter>
                </th>
                <th className="dash-num"><ColumnHead icon={IconHash} align="right">Attempts</ColumnHead></th>
                <th><ColumnHead icon={IconDoc}>Response</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Last Attempt</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Next Attempt</ColumnHead></th>
                <th><ColumnHead icon={IconReplay}>Replay Of</ColumnHead></th>
                <th><ColumnHead icon={IconActivity}>Actions</ColumnHead></th>
              </tr>
            </thead>
            {loading && deliveries.length === 0 ? <SkeletonRows rows={5} columns={9} /> : <tbody>
              {deliveries.map((delivery) => {
                // Replaying a `pending` row is pointless, it is already queued,
                // and the dispatcher leaves a row `pending` between retries. A
                // replay against a disabled endpoint is rejected `409` server
                // side, so the button is hidden rather than offered and refused,
                // since the endpoint's own state is already known on this page.
                const replayable =
                  (delivery.status === "succeeded" || delivery.status === "exhausted") &&
                  endpoint?.status === "active";
                return (
                  <tr key={delivery.id}>
                    <td>{dateTime(delivery.createdAt)}</td>
                    <td>{delivery.eventType}</td>
                    <td>
                      <StatusBadge status={delivery.status} />
                    </td>
                    <td className="dash-num">{delivery.attemptCount}</td>
                    <td>
                      {dash(delivery.responseStatusCode)}
                      {delivery.responseBodyExcerpt ? (
                        <details>
                          <summary>body</summary>
                          <pre className="dash-pre">{delivery.responseBodyExcerpt}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td>{dateTime(delivery.lastAttemptedAt)}</td>
                    <td>{dateTime(delivery.nextAttemptAt)}</td>
                    <td>
                      {delivery.replayOfDeliveryId ? (
                        <span className="dash-muted">
                          replay of <code>{delivery.replayOfDeliveryId}</code>
                        </span>
                      ) : (
                        dash(null)
                      )}
                    </td>
                    <td>
                      {replayable ? (
                        <button
                          type="button"
                          className="dash-button"
                          disabled={busyId === delivery.id}
                          onClick={() => void handleReplay(delivery)}
                        >
                          <IconReplay /> Replay
                        </button>
                      ) : (
                        dash(null)
                      )}
                    </td>
                  </tr>
                );
              })}
              {deliveries.length === 0 && !loading && !error ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={9}>
                    <EmptyState icon={IconWebhooks}>No deliveries match these filters.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{deliveries.length === 0 ? "0 results" : `Showing 1 to ${deliveries.length}${nextCursor ? ", more available" : ""}`}</span>
          <Pagination
            nextCursor={nextCursor}
            loading={loading}
            onLoadMore={() => void loadDeliveries(nextCursor)}
          />
        </div>
      </div>
    </section>
  );
}
