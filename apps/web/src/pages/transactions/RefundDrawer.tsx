import { useState } from "react";
import { ApiError, describeError } from "../../api/client.js";
import { refundTransaction } from "../../api/transactions.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { RefundResponse, TransactionDto } from "../../types.js";

/**
 * Exactly the statuses apps/api's `refundValidation.ts` accepts. A refund is
 * only ever a return of money that was actually captured, so `authorized`
 * and `voided` rows are never offered this control.
 */
const REFUNDABLE_STATUSES: ReadonlySet<TransactionDto["status"]> = new Set([
  "captured",
  "partially_captured",
  "partially_refunded",
]);

interface RefundDrawerProps {
  txn: TransactionDto;
  /** Runs after a successful refund so the page can refetch the transaction
   *  and its event timeline; the refund wrote a new event server-side. */
  onRefunded: (result: RefundResponse) => Promise<void>;
}

/**
 * The API's validation failures come back as `{ ok: false, code, ... }`
 * rather than the standard `{ error, message }` body, so the generic
 * `describeError` would show nothing useful for the two amount cases.
 * Everything else falls through to it.
 */
function describeRefundError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = typeof err.body.code === "string" ? err.body.code : err.code;
    if (code === "refund_exceeds_refundable") {
      const remaining = err.body.refundableFils;
      return typeof remaining === "number"
        ? `That is more than is still refundable — ${bhd(remaining)} remains.`
        : "That is more than is still refundable on this transaction.";
    }
    if (code === "refund_amount_invalid") {
      return "Enter a refund amount greater than zero fils.";
    }
    if (code === "transaction_not_refundable") {
      return "This transaction is no longer refundable.";
    }
    if (code === "refunds_on_hold") {
      return "Refunds are on hold for this merchant. Contact support.";
    }
    if (code === "refund_declined") {
      return "The acquirer declined the refund. No money moved.";
    }
    if (code === "acquirer_unavailable") {
      return "The acquirer is unavailable. The refund was not completed — try again.";
    }
  }
  return describeError(err);
}

/**
 * Refunds a captured transaction, in full (amount left blank) or in part.
 *
 * `txn.capturedFils` is the ceiling this page can offer: `serializeTransaction`
 * deliberately omits `refundedFils`, so the true remaining refundable amount
 * is only known server-side (captured minus already refunded). The input is
 * bounded by the captured total here and the API's own validation is the
 * authoritative gate for a partially refunded row.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refundable = REFUNDABLE_STATUSES.has(txn.status);

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!refundable) return;

    const trimmed = amount.trim();
    let amountFils: number | undefined;
    if (trimmed !== "") {
      if (!/^\d+$/.test(trimmed)) {
        setError("Enter a whole number of fils, or leave it blank to refund the full captured amount.");
        return;
      }
      amountFils = Number(trimmed);
      if (!Number.isSafeInteger(amountFils) || amountFils <= 0) {
        setError("Enter a refund amount greater than zero fils.");
        return;
      }
      if (amountFils > txn.capturedFils) {
        setError(`Refund cannot exceed the captured amount of ${bhd(txn.capturedFils)}.`);
        return;
      }
    }

    if (
      !window.confirm(
        "Refund this transaction? The money goes back to the cardholder and cannot be recalled.",
      )
    ) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await refundTransaction(
        {
          transactionId: txn.id,
          // Omitted entirely when blank: the API refunds everything still
          // refundable — its own documented default. Computing the remainder
          // here would just be a second, staler copy of that rule.
          ...(amountFils === undefined ? {} : { amountFils }),
        },
        // A fresh key per submit action, the same discipline capture uses.
        crypto.randomUUID(),
      );

      setOpen(false);
      setAmount("");
      await onRefunded(result);
    } catch (err) {
      setError(describeRefundError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

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
                max={txn.capturedFils}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">Captured: {bhd(txn.capturedFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button
              type="button"
              className="dash-button"
              disabled={submitting}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
