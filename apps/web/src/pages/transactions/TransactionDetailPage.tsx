import {
  EmptyState,
  IconReceipt,
  PageHeader,
  Skeleton,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { IconArrowLeft } from "../../components/icons.js";
import { actorLabel, dash, dateTime, parseRefundAmount, refundedFilsFromEvents } from "../../format.js";
import { RefundDrawer } from "./RefundDrawer.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

/** The server enum value as a human label, Title Cased, underscore removed. */
function label(value: string): string {
  return value
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page: one
 * feature, so one view, not two navigable routes.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads: the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const amountFils = parseRefundAmount(captureAmount);
      // Left blank, `amountFils` is omitted entirely and capture.ts captures
      // everything still outstanding, its own documented default. Computing
      // the remainder here would just be a second, staler copy of that rule.
      const input = amountFils === undefined ? {} : { amountFils };
      // A fresh Idempotency-Key per click, including a retry after a decline,
      // same discipline as the checkout page's submit handler.
      await captureTransaction(id, input, crypto.randomUUID());
      setCaptureOpen(false);
      setCaptureAmount("");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id) return;
    if (
      !window.confirm(
        "Void this authorization? The held funds are released and cannot be captured afterwards.",
      )
    ) {
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row,
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Transaction" />
        <div className="fp-loading" aria-label="Loading" aria-busy="true"><Skeleton height={28} width="45%" /><Skeleton height={72} /><Skeleton height={72} /></div>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return <section className="fp-page fp-stagger">
      <PageHeader title="Transaction" back={<Link to="/dashboard/transactions"><IconArrowLeft /> Back</Link>} />
      <div className="dash-card"><EmptyState icon={IconReceipt}>No transaction with this id exists on your account.</EmptyState></div>
    </section>;
  }
  if (state.kind === "error") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Transaction" />
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";
  const refundedFils = refundedFilsFromEvents(events);

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Transaction" lede={txn.reference ?? undefined} status={<StatusBadge status={txn.status} />} back={<Link to="/dashboard/transactions"><IconArrowLeft /> Back</Link>} actions={<> {/* Capture and void are hidden from `support`, since a support agent looks
          things up and does not move money. The API enforces the same rule
          (requireMerchantRole("owner", "finance") on both routes); this hide
          only keeps the buttons out of a support user's way. */}
        <RequireRole allow={["owner", "finance"]}>
          {capturable || voidable ? (
            <div className="dash-actions">
              {actionError ? (
                <p className="dash-error" style={{ flex: "1 1 100%" }}>
                  {actionError}
                </p>
              ) : null}

              {capturable ? (
                captureOpen ? (
                  <form className="dash-form dash-form-inline" onSubmit={(e) => void handleCapture(e)}>
                    <label>
                      Amount in BHD (blank captures everything outstanding)
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.000"
                        value={captureAmount}
                        onChange={(e) => setCaptureAmount(e.target.value)}
                      />
                    </label>
                    <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                      {submitting ? "Capturing" : "Capture"}
                    </button>
                    <button
                      type="button"
                      className="dash-button"
                      disabled={submitting}
                      onClick={() => setCaptureOpen(false)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="dash-button dash-button-primary"
                    onClick={() => setCaptureOpen(true)}
                  >
                    Capture
                  </button>
                )
              ) : null}

              {voidable ? (
                <button
                  type="button"
                  className="dash-button dash-button-danger"
                  disabled={submitting}
                  onClick={() => void handleVoid()}
                >
                  Void
                </button>
              ) : null}
            </div>
          ) : null}
        </RequireRole>

        <RefundDrawer txn={txn} refundableFils={Math.max(0, txn.capturedFils - refundedFils)} onRefunded={load} /> </>} />

      <div className="dash-card">
        <div className="fp-detail-amount"><span>Authorized amount</span><Money fils={txn.amountFils} size="hero" /></div>
        <dl className="dash-dl">

          <div className="dash-fact"><dt>Captured amount</dt>
            <dd>
              <Money fils={txn.capturedFils} />
            </dd></div>
          <div className="dash-fact"><dt>Refunded amount</dt>
            <dd>
              <Money fils={refundedFils} />
            </dd></div>
          <div className="dash-fact"><dt>Currency</dt>
            <dd>{txn.currency}</dd></div>
          <div className="dash-fact"><dt>Reference</dt>
            <dd>{dash(txn.reference)}</dd></div>
          <div className="dash-fact"><dt>Acquirer reference</dt>
            <dd>
              <code>{txn.acquirerReference}</code>
            </dd></div>
          <div className="dash-fact"><dt>Occurred at</dt>
            <dd>{dateTime(txn.occurredAt)}</dd></div>
          <div className="dash-fact"><dt>Created at</dt>
            <dd>{dateTime(txn.createdAt)}</dd></div>
        </dl>
      </div>

      <section className="dash-card">
        <div className="dash-card-head"><h2 className="dash-card-title">Event timeline</h2></div>
        <ol className="fp-timeline">
          {events.map((event) => (
            <li key={event.id}>
              <div><StatusBadge status={event.eventType}>{label(event.eventType)}</StatusBadge>
                <div className="fp-timeline-meta">{actorLabel(event.actorType)}</div>
              </div>
              <time>{dateTime(event.occurredAt)}</time>
              <div>{event.amountFils === null ? dash(null) : <Money fils={event.amountFils} />}</div>
            </li>
          ))}
        </ol>
        {events.length === 0 ? <EmptyState icon={IconReceipt}>No events recorded.</EmptyState> : null}
      </section>
    </section>
  );
}
