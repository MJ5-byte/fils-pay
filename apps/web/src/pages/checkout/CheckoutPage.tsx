import {
  IconAlert,
  IconCoins,
  IconSearch,
  IconShield,
  Money,
  Skeleton,
  StatusBadge,
  Tag,
  formatDateTime,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { CheckoutSummary } from "./CheckoutSummary.js";
import { loadFailureKind } from "./loadFailure.js";
import { payFailure } from "./payFailure.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string; title?: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 0, expiryYear: 0, cvv: "" };

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return () => {};
    }
    let cancelled = false;
    setLoadState({ kind: "loading" });
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadState({ kind: loadFailureKind(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || !card.expiryMonth || !card.expiryYear) return;

    // A fresh Idempotency-Key per explicit user action, every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card, submittedAt }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      setPayState(payFailure(err));
    }
  }

  if (loadState.kind === "loading") {
    return (
      <main className="checkout-page">
        <div className="fp-loading" aria-busy="true" aria-label="Loading payment"><Skeleton width="55%" height={28} /><Skeleton height={56} /><Skeleton height={180} /></div>
      </main>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <main className="checkout-page">
        <IconSearch className="checkout-state-icon" /><h1>Payment link not found</h1>
      </main>
    );
  }

  if (loadState.kind === "error") {
    return (
      <main className="checkout-page">
        <h1>Couldn't load payment link</h1>
        <p>We couldn't load this payment link right now. Please try again.</p>
        <button type="button" className="dash-button dash-button-primary" onClick={load}>
          Try again
        </button>
      </main>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <StatusBadge status="succeeded">Payment successful</StatusBadge><h1>Thank you, your payment has been received.</h1>
        <dl className="dash-dl">
          <div className="dash-fact"><dt>Transaction ID</dt>
            <dd>{payState.result.transactionId}</dd></div>
          <div className="dash-fact"><dt>Paid at</dt>
            <dd>{formatDateTime(payState.result.paidAt)}</dd></div>
        </dl>
      </main>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <IconAlert className="checkout-state-icon" /><h1>{payState.title ?? "Unable to pay"}</h1>
        <p>{payState.message}</p>
      </main>
    );
  }

  if (link.status === "paid") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <StatusBadge status="paid" /><h1>This invoice has already been paid.</h1>
      </main>
    );
  }
  if (link.status === "expired") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <StatusBadge status="expired" /><h1>This payment link has expired.</h1>
      </main>
    );
  }
  if (link.status === "canceled") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <StatusBadge status="canceled" /><h1>This payment link is no longer available.</h1>
      </main>
    );
  }
  if (link.status === "processing") {
    return (
      <main className="checkout-page">
        <CheckoutSummary merchantDisplayName={link.merchantDisplayName} amountFils={link.amountFils} />
        <StatusBadge status="processing" /><h1>A payment is being processed for this link, please wait a moment and refresh.</h1>
      </main>
    );
  }

  // link.status === 'active'
  const currentYear = new Date().getFullYear();
  const submitting = payState.kind === "submitting";

  return (
    <main className="checkout-page">
      <h1 className="checkout-merchant">{link.merchantDisplayName}</h1>
      <div className="checkout-amount"><Money fils={link.amountFils} size="hero" /></div>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}

      {payState.kind === "declined" ? <p className="dash-error"><IconAlert /> {payState.message}</p> : null}

      <form onSubmit={handleSubmit} className="checkout-form">
        <label>
          Card number
          <input
            type="text"
            inputMode="numeric"
            placeholder="4242 4242 4242 4242"
            autoComplete="cc-number"
            required
            maxLength={23}
            value={card.pan}
            onChange={(e) => {
              // Card numbers run 12 to 19 digits (what the API accepts), shown
              // in groups of four; the API strips the spaces before Luhn.
              const digits = e.target.value.replace(/\D/g, "").slice(0, 19);
              const pan = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
              setCard({ ...card, pan });
              if (digits.length >= 4) {
                void import("../../utils/helpers.js").then((m) => {
                  setBrandHint(m.formatCardBrandHint(digits));
                });
              } else {
                setBrandHint(null);
              }
            }}
          />
          {brandHint && brandHint !== "unknown" ? (
            <Tag icon={IconCoins}>{brandHint}</Tag>
          ) : null}
        </label>
        <div className="checkout-form-row">
          <fieldset className="checkout-expiry">
            <legend>Expiry</legend>
            <div className="checkout-expiry-inputs">
              <select aria-label="Expiry month" autoComplete="cc-exp-month" required value={card.expiryMonth || ""}
                onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}>
                <option value="" disabled>MM</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                  <option key={month} value={month}>{String(month).padStart(2, "0")}</option>
                ))}
              </select>
              <select aria-label="Expiry year" autoComplete="cc-exp-year" required value={card.expiryYear || ""}
                onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}>
                <option value="" disabled>YYYY</option>
                {Array.from({ length: 11 }, (_, i) => currentYear + i).map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
          </fieldset>
          <label>
            CVV
            <input
              type="text"
              inputMode="numeric"
              required
              placeholder="123"
              autoComplete="cc-csc"
              maxLength={4}
              value={card.cvv}
              onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
          </label>
        </div>
        <button type="submit" className="dash-button dash-button-primary" disabled={submitting || !card.expiryMonth || !card.expiryYear}>
          <IconShield />
          {submitting ? "Processing..." : <>Pay <Money fils={link.amountFils} /></>}
        </button>
      </form>

      <p className="checkout-secured"><IconShield /> Secured by FilsPay</p>
      <p className="checkout-help">
        Test cards (simulated acquirer, no real charge): any other number approves; a card number ending{" "}
        <code>0002</code> always declines (do not honor); ending <code>0119</code> always declines
        (insufficient funds); ending <code>0069</code> always errors.
      </p>
    </main>
  );
}
