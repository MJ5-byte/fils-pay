import {
  ColumnHead,
  IconActivity,
  IconCalendar,
  IconClock,
  IconKeyRound,
  IconLinks,
  PageHeader,
  SkeletonRows,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconPlus, IconPower, IconTrash, IconWebhooks } from "../../components/icons.js";
import { dateTime } from "../../format.js";
import type { WebhookEndpointDto } from "../../types.js";

/**
 * `GET /v1/merchants/:merchantId/webhook-endpoints`. Unlike most
 * list reads in this platform, this one is `owner`/`finance` only
 * server-side, so a `support` user reaching this page gets a real `403`,
 * which `describeError` renders plainly. The nav link is hidden from them too
 * (DashboardLayout), but a typed URL still lands here, and it must explain
 * itself rather than sit on a blank loading state.
 */
export function WebhookEndpointListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [endpoints, setEndpoints] = useState<WebhookEndpointDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      setEndpoints(await listWebhookEndpoints(merchantId));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    setBusyId(endpoint.id);
    setError(null);
    try {
      await updateWebhookEndpoint(merchantId, endpoint.id, {
        status: endpoint.status === "active" ? "disabled" : "active",
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  // delete 500s if the endpoint has deliveries, am
  // MK: fixed in FP-240
  async function handleDelete(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    // A hard delete, the endpoint row is gone, while its delivery log
    // outlives it. Irreversible, so it asks first.
    if (
      !window.confirm(
        `Delete ${endpoint.url}? This cannot be undone, and its secret cannot be recovered.`,
      )
    ) {
      return;
    }
    setBusyId(endpoint.id);
    setError(null);
    try {
      await deleteWebhookEndpoint(merchantId, endpoint.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader
        title="Webhook endpoints"
        lede={<> Where we deliver event notifications, and the health of each. </>}
        actions={
          <Link className="dash-button dash-button-primary" to="/dashboard/webhooks/new">
            <IconPlus /> New endpoint
          </Link>
        }
      />
      <div className="fp-list-card">
        {error ? <p className="dash-error">{error}</p> : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconLinks}>URL</ColumnHead></th>
                <th><ColumnHead icon={IconKeyRound}>Secret Prefix</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
                <th><ColumnHead icon={IconActivity}>Actions</ColumnHead></th>
              </tr>
            </thead>
            {loading && endpoints.length === 0 ? <SkeletonRows rows={5} columns={5} /> : <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>
                    <Link to={`/dashboard/webhooks/${endpoint.id}`}>{endpoint.url}</Link>
                  </td>
                  <td>
                    <code>{endpoint.secretPrefix}</code>
                  </td>
                  <td>
                    <StatusBadge status={endpoint.status} />
                  </td>
                  <td>{dateTime(endpoint.createdAt)}</td>
                  <td>
                    <div className="dash-row-actions">
                      <button
                        type="button"
                        className="dash-button"
                        disabled={busyId === endpoint.id}
                        onClick={() => void handleToggle(endpoint)}
                      >
                        <IconPower /> {endpoint.status === "active" ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="dash-button dash-button-danger"
                        disabled={busyId === endpoint.id}
                        onClick={() => void handleDelete(endpoint)}
                      >
                        <IconTrash /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {endpoints.length === 0 && !loading && !error ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={5}>
                    <EmptyState icon={IconWebhooks}>No webhook endpoints registered.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{endpoints.length} endpoints</span></div>
      </div>
    </section>
  );
}
