import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getMerchant, listMerchants } from "../../api/merchants.js";
import { replayBatch } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import type {
  AdminMerchantDetail,
  AdminMerchantSummary,
  BatchReplayResult,
  WebhookDeliveryStatus,
} from "../../types.js";
import { statusLabel } from "../../format.js";

const REPLAYABLE_STATUSES: WebhookDeliveryStatus[] = [
  "exhausted",
  "failed",
  "pending",
  "succeeded",
];

/** `<input type="datetime-local">` wants a local-time `YYYY-MM-DDTHH:mm`
 *  string; the API wants ISO-8601 instants. Convert at both edges rather
 *  than making the operator think about timezones. */
function toLocalInputValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

// default window is local time — am
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: toLocalInputValue(weekAgo), to: toLocalInputValue(now) };
}

/**
 * Replay every delivery for one endpoint inside a date range. Any
 * admin role: it is routine, reversible, and deduped receiver-side by the
 * delivery id, so no money moves as a direct result.
 */
export function WebhookReplayPage() {
  const { merchantId } = useParams<{ merchantId?: string }>();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<AdminMerchantSummary[]>([]);
  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);

  const [endpointId, setEndpointId] = useState("");
  const [range, setRange] = useState(defaultRange);
  const [statuses, setStatuses] = useState<WebhookDeliveryStatus[]>(["exhausted"]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchReplayResult | null>(null);

  const loadMerchant = useCallback(async () => {
    if (!merchantId) {
      setDetail(null);
      return;
    }
    setError(null);
    try {
      const loaded = await getMerchant(merchantId);
      setDetail(loaded);
      const firstActive = (loaded.webhookEndpoints ?? []).find((e) => e.status === "active");
      setEndpointId(firstActive?.id ?? "");
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId]);

  useEffect(() => {
    void loadMerchant();
  }, [loadMerchant]);

  async function handleSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const found = await listMerchants({ q: search.trim() || undefined, limit: 10 });
      setCandidates(found.merchants ?? []);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  /** Replays keep the original Webhook-Delivery-Id so receivers can dedupe. */
  async function handleReplay(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || !endpointId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await replayBatch(merchantId, endpointId, {
          from: new Date(range.from).toISOString(),
          to: new Date(range.to).toISOString(),
          statuses: statuses.length > 0 ? statuses : undefined,
        }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!merchantId) {
    return (
      <section>
        <h1>Webhook replay</h1>
        <p className="admin-muted">Pick the merchant whose endpoint needs a replay.</p>
        {error ? <p className="admin-error">{error}</p> : null}
        <form className="admin-form admin-form-inline" onSubmit={(e) => void handleSearch(e)}>
          <label>
            Search merchants
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Display name, merchant id, or contact email"
            />
          </label>
          <button type="submit">Search</button>
        </form>
        <ul>
          {candidates.map((merchant) => (
            <li key={merchant.id}>
              <button type="button" onClick={() => navigate(`/webhooks/${merchant.id}`)}>
                {merchant.displayName}
              </button>{" "}
              <code className="admin-muted">{merchant.id}</code>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const endpoints = detail?.webhookEndpoints ?? [];

  return (
    <section>
      <p>
        <Link to="/webhooks">&larr; Pick a different merchant</Link>
      </p>
      <h1>Webhook replay</h1>
      <p>
        Merchant:{" "}
        {detail ? (
          <Link to={`/merchants/${merchantId}`}>{detail.merchant.displayName}</Link>
        ) : (
          <code>{merchantId}</code>
        )}
      </p>

      {error ? <p className="admin-error">{error}</p> : null}

      {detail && endpoints.length === 0 ? (
        <p className="admin-muted">This merchant has no webhook endpoints registered.</p>
      ) : null}

      <form className="admin-form" onSubmit={(e) => void handleReplay(e)}>
        <label>
          Endpoint
          <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} required>
            <option value="" disabled>
              Select an endpoint
            </option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.url} ({statusLabel(endpoint.status)})
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="datetime-local"
            required
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            required
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </label>
        <fieldset className="admin-filters">
          <legend>Delivery statuses to replay</legend>
          {REPLAYABLE_STATUSES.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={statuses.includes(status)}
                onChange={() => toggleStatus(status)}
              />
              {status}
            </label>
          ))}
          <p className="admin-muted">
            Defaults to <code>exhausted</code> — the one terminal failure state the dispatcher
            produces. Replaying a <code>succeeded</code> delivery is allowed but resends an event the
            receiver already accepted.
          </p>
        </fieldset>
        <button type="submit" disabled={busy || !endpointId}>
          {busy ? "Replaying..." : "Replay batch"}
        </button>
      </form>

      {result ? (
        <div className="admin-notice">
          <p>
            Matched {result.matchedCount} deliver{result.matchedCount === 1 ? "y" : "ies"}; queued{" "}
            {(result.replayedDeliveryIds ?? []).length} replay
            {(result.replayedDeliveryIds ?? []).length === 1 ? "" : "s"}. They are sent by the normal
            async dispatcher pass, not immediately by this request.
          </p>
          {(result.replayedDeliveryIds ?? []).length > 0 ? (
            <ul className="admin-id-list">
              {(result.replayedDeliveryIds ?? []).map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
