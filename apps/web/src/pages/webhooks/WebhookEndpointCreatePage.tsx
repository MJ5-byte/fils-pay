import {
  IconWebhooks,
  PageHeader,
  StatusBadge,
} from "@filspay/ui";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createWebhookEndpoint } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { IconArrowLeft, IconCopy } from "../../components/icons.js";
import { dateTime } from "../../format.js";
import type { WebhookEndpointCreateResponse } from "../../types.js";

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints`.
 *
 * The `201` response is the only time the signing secret is ever returned,
 * it is stored encrypted at rest (not hashed, because each delivery's HMAC
 * needs the plaintext back) and no read endpoint returns it again. So this
 * page never navigates away on its own: the merchant has to acknowledge the
 * secret panel, which is what stops an accidental redirect or back-button
 * from losing a credential that cannot be re-issued.
 */
export function WebhookEndpointCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebhookEndpointCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  /** The response carries the secret; this is the only time it is shown. */
  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setSubmitting(true);
    setError(null);
    try {
      setCreated(await createWebhookEndpoint(me.merchant.id, { url: url.trim() }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // MK: secret is shown once only
  async function handleCopy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // The secret is on screen and selectable, nothing to recover from.
      setCopied(false);
    }
  }

  if (created) {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Endpoint created" status={<StatusBadge status={created.status} />} />
        <div className="fp-form-card">

          <div className="dash-confirm">
            <h2>Signing secret, shown once</h2>
            <p>
              <strong>This will not be shown again.</strong> Store it now; every delivery
              to this endpoint is signed with it, and it cannot be re-read or recovered.
            </p>
            <p>
              <code className="dash-secret">{created.secret}</code>{" "}
              <button
                type="button"
                className="dash-button"
                onClick={() => void handleCopy(created.secret)}
              >
                <IconCopy /> {copied ? "Copied" : "Copy secret"}
              </button>
            </p>
          </div>

          <dl className="dash-dl">
            <div className="dash-fact"><dt>URL</dt>
              <dd>{created.url}</dd></div>
            <div className="dash-fact"><dt>Secret prefix</dt>
              <dd>
                <code>{created.secretPrefix}</code>
              </dd></div>
            <div className="dash-fact"><dt>Status</dt>
              <dd><StatusBadge status={created.status} /></dd></div>
            <div className="dash-fact"><dt>Created at</dt>
              <dd>{dateTime(created.createdAt)}</dd></div>
          </dl>

          <button
            type="button"
            className="dash-button dash-button-primary"
            onClick={() => navigate(`/dashboard/webhooks/${created.id}`, { replace: true })}
          >
            I&apos;ve saved it, continue
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="New webhook endpoint" lede={<> We sign every delivery to this URL so you can verify it came from us. </>} back={<Link to="/dashboard/webhooks"><IconArrowLeft /> Back</Link>} />

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form fp-form-card" onSubmit={(e) => void handleSubmit(e)}>
        <p className="fp-eyebrow"><IconWebhooks />Delivery details</p>
        <label>
          Endpoint URL
          <input
            type="url"
            required
            placeholder="https://example.com/filspay/webhooks"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="fp-form-actions"><Link className="dash-button-ghost" to="/dashboard/webhooks">Cancel</Link>
          <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
            {submitting ? "Creating" : "Create endpoint"}
          </button>
        </div>
      </form>
    </section>
  );
}
