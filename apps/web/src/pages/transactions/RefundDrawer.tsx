import {
  IconReturn,
  IconX,
} from "@filspay/ui";
import { useRef, useState } from "react";
import { refundTransaction } from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, parseRefundAmount } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundDrawerProps {
  txn: TransactionDto;
  /** Captured minus already refunded, in fils. */
  refundableFils: number;
  onRefunded: () => Promise<void>;
}

/** Hidden from `support` like capture and void; the API enforces the same
 *  owner/finance rule, this only keeps the button out of their way. */
export function RefundDrawer({ txn, refundableFils, onRefunded }: RefundDrawerProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const pendingKey = useRef<{ key: string; amount: string } | null>(null);

  const refundable =
    refundableFils > 0 &&
    (txn.status === "captured" || txn.status === "partially_captured" || txn.status === "partially_refunded");

  let amountError: string | null = null;
  let typedFils: number | undefined;
  try {
    typedFils = parseRefundAmount(amount, refundableFils);
  } catch (err) {
    amountError = describeError(err);
  }

  function askConfirm(event: React.FormEvent): void {
    event.preventDefault();
    try {
      parseRefundAmount(amount, refundableFils);
    } catch (err) {
      setError(describeError(err));
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function handleRefund(): Promise<void> {
    let amountFils: number | undefined;
    try {
      amountFils = parseRefundAmount(amount, refundableFils);
    } catch (err) {
      setError(describeError(err));
      setConfirming(false);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // A fresh key per submit, except a retry of the same amount after an
      // unknown outcome (no HTTP answer): that reuses the key so the server
      // replays the first result instead of refunding twice.
      const key = pendingKey.current?.amount === amount ? pendingKey.current.key : crypto.randomUUID();
      pendingKey.current = { key, amount };
      await refundTransaction(
        amountFils === undefined ? { transactionId: txn.id } : { transactionId: txn.id, amountFils },
        key,
      );
      pendingKey.current = null;
      setOpen(false);
      setConfirming(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new timeline event.
      await onRefunded();
    } catch (err) {
      // The server answered, so the outcome is known and the key is spent.
      if (err instanceof ApiError) pendingKey.current = null;
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="fp-refund-action">
        {error ? <p className="dash-error">{error}</p> : null}
        {open && confirming ? (
          <div className="dash-confirm">
            <p>
              <strong>Refund {bhd(typedFils ?? refundableFils)} to the cardholder?</strong>{" "}
              The money goes back to their card and cannot be recalled.
            </p>
            <button type="button" className="dash-button dash-button-danger" disabled={submitting} onClick={() => void handleRefund()}>
              <IconReturn />{submitting ? "Refunding..." : "Yes, refund"}
            </button>{" "}
            <button type="button" className="dash-button dash-button-ghost" disabled={submitting} onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        ) : open ? (
          <form className="dash-form fp-form-card fp-action-form" onSubmit={askConfirm}>
            <label>
              Amount in BHD (blank refunds everything still refundable)
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            {amountError ? <p className="dash-error">{amountError}</p> : null}
            <button type="submit" className="dash-button dash-button-primary" disabled={submitting || amountError !== null}>
              <IconReturn />{submitting ? "Refunding..." : amount.trim() === "" ? `Full refund (${bhd(refundableFils)})` : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              <IconX /> Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            <IconReturn /> Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
