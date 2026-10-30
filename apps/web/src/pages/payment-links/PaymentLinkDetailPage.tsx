import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPaymentLink, getMerchantPaymentLink } from "../../api/paymentLinks.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime } from "../../format.js";
import type { PaymentLinkDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkDto };

export function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      setState({ kind: "loaded", link: await getMerchantPaymentLink(merchantId, id) });
    } catch (err) {
      setState(
        err instanceof ApiError && err.statusCode === 404
          ? { kind: "not_found" }
          : { kind: "error", message: describeError(err) },
      );
    }
  }, [merchantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(): Promise<void> {
    if (!merchantId || !id) return;
    if (!window.confirm("Cancel this payment link? It can no longer be paid.")) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelPaymentLink(merchantId, id);
      await load();
    } catch (err) {
      // Includes `409 not_cancelable` for a link that is paid, already
      // canceled, or `reserved` mid-payment-attempt.
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission (or no secure context) — the URL is already
      // on screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  }

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "error") {
    return (
      <section>
        <h1>Payment link</h1>
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Payment link not found</h1>
        <p>
          This payment link does not exist.{" "}
          <Link to="/dashboard/payment-links">Back to payment links</Link>
        </p>
      </section>
    );
  }

  const { link } = state;

  return (
    <section>
      <h1>Payment link</h1>
      <p className="dash-muted">
        <code>{link.id}</code>
      </p>

      <dl className="dash-dl">
        <dt>Amount</dt>
        <dd>{bhd(link.amountFils)}</dd>
        <dt>Currency</dt>
        <dd>{link.currency}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${link.status}`}>{link.status}</span>
        </dd>
        <dt>Reference</dt>
        <dd>{dash(link.reference)}</dd>
        <dt>Description</dt>
        <dd>{dash(link.description)}</dd>
        <dt>Expires at</dt>
        <dd>{dateTime(link.expiresAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(link.createdAt)}</dd>
        <dt>Paid at</dt>
        <dd>{dateTime(link.paidAt)}</dd>
        <dt>Canceled at</dt>
        <dd>{dateTime(link.canceledAt)}</dd>
        <dt>Transaction</dt>
        <dd>
          {link.transactionId ? (
            <Link to={`/dashboard/transactions/${link.transactionId}`}>
              <code>{link.transactionId}</code>
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt>Checkout link</dt>
        <dd>
          {/* Linked to, never duplicated — /pay/:token is the one checkout
              implementation, and there is no preview of it embedded here. */}
          <a href={link.url} target="_blank" rel="noreferrer">
            {link.url}
          </a>{" "}
          <button type="button" className="dash-button" onClick={() => void handleCopy(link.url)}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </dd>
      </dl>

      {actionError ? <p className="dash-error">{actionError}</p> : null}

      {link.status === "active" ? (
        <RequireRole allow={["owner", "finance"]}>
          <button
            type="button"
            className="dash-button"
            disabled={submitting}
            onClick={() => void handleCancel()}
          >
            {submitting ? "Canceling..." : "Cancel payment link"}
          </button>
        </RequireRole>
      ) : null}

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}
