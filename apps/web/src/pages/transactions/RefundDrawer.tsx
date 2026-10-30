import { useRef, useState } from "react";
import { describeError, request } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";
import { refundableFils } from "../../refunds/refundable.js";

/**
 * Refund action on the transaction page (FP-212). Calls `POST /v1/refunds`
 * with the transaction in the body; the merchant comes from the session
 * server-side.
 *
 * Shown only to owner and finance, and only when `me.merchant.refundsEnabled`
 * (FEATURE_REFUNDS on and no refund hold). Hiding it is a convenience; the
 * API enforces the role, the flag and the hold itself.
 */

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund attempt, not per click: resubmitting the same request
  // (a network retry, an acquirer timeout) reuses it, so the server replays
  // the first result instead of refunding twice. Opening the form or changing
  // the amount starts a new attempt.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const remaining = refundableFils(txn);
  if (!me?.merchant.refundsEnabled || !REFUNDABLE_STATUSES.has(txn.status) || remaining <= 0) {
    return null;
  }

  function startNewAttempt(): void {
    idempotencyKey.current = crypto.randomUUID();
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = amount.trim();
    const amountFils = trimmed === "" ? undefined : Number(trimmed);
    if (amountFils !== undefined && (!Number.isSafeInteger(amountFils) || amountFils <= 0 || amountFils > remaining)) {
      setError(`Amount must be a whole number of fils from 1 to ${remaining}.`);
      return;
    }
    const shown = bhd(amountFils ?? remaining);
    if (!window.confirm(`Refund ${shown}? The money goes back to the cardholder and cannot be recalled.`)) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted and the API refunds everything
      // still refundable.
      const body = amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils };
      await request<RefundResponse>("/v1/refunds", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      startNewAttempt();
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={remaining}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  startNewAttempt();
                }}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(remaining)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="dash-button"
            onClick={() => {
              startNewAttempt();
              setError(null);
              setOpen(true);
            }}
          >
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
