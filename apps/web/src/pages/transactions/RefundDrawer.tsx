import { useRef, useState } from "react";
import { request, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

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

/**
 * Refund control for the transaction page. What can still go back is what was
 * CAPTURED minus what has already been refunded (the server enforces the same
 * rule under a row lock; this only keeps the form honest).
 *
 * The Idempotency-Key is created once per refund *attempt* and reused if the
 * same attempt is retried (network error, double click), then replaced after a
 * success so the next refund is a new operation.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptKey = useRef<{ key: string; fingerprint: string } | null>(null);

  const merchantId = me?.merchant.id;
  const refundableFils = Math.max(0, txn.capturedFils - txn.refundedFils);

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;

    const trimmed = amount.trim();
    if (trimmed !== "" && (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > refundableFils)) {
      setError(`Enter a whole number of fils between 1 and ${refundableFils}.`);
      return;
    }
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted and the API refunds everything still refundable.
      const body = trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) };
      const fingerprint = JSON.stringify(body);
      if (!attemptKey.current || attemptKey.current.fingerprint !== fingerprint) {
        attemptKey.current = { key: crypto.randomUUID(), fingerprint };
      }

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": attemptKey.current.key },
        body: JSON.stringify(body),
      });

      attemptKey.current = null;
      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new timeline row server-side.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!REFUNDABLE_STATUSES.has(txn.status) || refundableFils <= 0) return null;

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
                max={refundableFils}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">Refundable now: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
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
