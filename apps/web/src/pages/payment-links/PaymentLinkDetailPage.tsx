import {
  EmptyState,
  IconLinks,
  PageHeader,
  Skeleton,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPaymentLink, getMerchantPaymentLink } from "../../api/paymentLinks.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { IconArrowLeft, IconCopy } from "../../components/icons.js";
import { dash, dateTime } from "../../format.js";
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
      // No clipboard permission (or no secure context), the URL is already
      // on screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Payment link" />
        <div className="fp-loading" aria-label="Loading" aria-busy="true"><Skeleton height={28} width="45%" /><Skeleton height={72} /><Skeleton height={72} /></div>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Payment link" />
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return <section className="fp-page fp-stagger">
      <PageHeader title="Payment link" back={<Link to="/dashboard/payment-links"><IconArrowLeft /> Back</Link>} />
      <div className="dash-card"><EmptyState icon={IconLinks}>This payment link does not exist.</EmptyState></div>
    </section>;
  }

  const { link } = state;

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Payment link" lede={link.reference ?? link.description ?? undefined} status={<StatusBadge status={link.status} />} back={<Link to="/dashboard/payment-links"><IconArrowLeft /> Back</Link>} actions={<>       {link.status === "active" ? (
        <RequireRole allow={["owner", "finance"]}>
          <div className="dash-actions">
            <button
              type="button"
              className="dash-button dash-button-danger"
              disabled={submitting}
              onClick={() => void handleCancel()}
            >
              {submitting ? "Canceling" : "Cancel payment link"}
            </button>
          </div>
        </RequireRole>
      ) : null} </>} />

      <div className="dash-card">
        <div className="fp-detail-amount"><span>Amount</span><Money fils={link.amountFils} size="hero" /></div>
        <dl className="dash-dl">

          <div className="dash-fact"><dt>Currency</dt>
            <dd>{link.currency}</dd></div>
          <div className="dash-fact"><dt>Reference</dt>
            <dd>{dash(link.reference)}</dd></div>
          <div className="dash-fact"><dt>Description</dt>
            <dd>{dash(link.description)}</dd></div>
          <div className="dash-fact"><dt>Expires at</dt>
            <dd>{dateTime(link.expiresAt)}</dd></div>
          <div className="dash-fact"><dt>Created at</dt>
            <dd>{dateTime(link.createdAt)}</dd></div>
          <div className="dash-fact"><dt>Paid at</dt>
            <dd>{dateTime(link.paidAt)}</dd></div>
          <div className="dash-fact"><dt>Canceled at</dt>
            <dd>{dateTime(link.canceledAt)}</dd></div>
          <div className="dash-fact"><dt>Transaction</dt>
            <dd>
              {link.transactionId ? (
                <Link to={`/dashboard/transactions/${link.transactionId}`}>
                  <code>{link.transactionId}</code>
                </Link>
              ) : (
                "–"
              )}
            </dd></div>
          <div className="dash-fact"><dt>Checkout link</dt>
            <dd>
              {/* Linked to, never duplicated, /pay/:token is the one checkout
              implementation, and there is no preview of it embedded here. */}
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.url}
              </a>{" "}
              <button type="button" className="dash-button" onClick={() => void handleCopy(link.url)}>
                <IconCopy /> {copied ? "Copied" : "Copy link"}
              </button>
            </dd></div>
        </dl>
      </div>

      {actionError ? <p className="dash-error">{actionError}</p> : null}

    </section>
  );
}
