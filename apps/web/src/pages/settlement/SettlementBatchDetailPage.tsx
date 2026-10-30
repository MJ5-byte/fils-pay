import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSettlementBatch, getSettlementBatchTransactions } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import type { SettlementBatchDetailDto, SettlementBatchTransactionDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; batch: SettlementBatchDetailDto };

/**
 * `GET /v1/settlement/batches/:id` plus its line items.
 *
 * The two counts are rendered as two separately-labeled figures and never
 * added, averaged, or presented as one number: a transaction captured twice
 * inside the batch window contributes one scheme export line but two capture
 * events, so they can legitimately differ. Conflating them would invent a
 * discrepancy where there isn't one — or hide a real one.
 *
 * No pagination on the line items: the endpoint has none, and adding a
 * client-side cap would silently drop rows from a settlement figure.
 */
export function SettlementBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lines, setLines] = useState<SettlementBatchTransactionDto[]>([]);

  useEffect(() => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [batch, txns] = await Promise.all([
          getSettlementBatch(id),
          getSettlementBatchTransactions(id),
        ]);
        if (cancelled) return;
        setState({ kind: "loaded", batch });
        setLines(txns.transactions);
      } catch (err) {
        if (cancelled) return;
        // 404, not 403, for another merchant's batch — the same non-disclosure
        // choice the transaction detail read makes.
        if (err instanceof ApiError && err.statusCode === 404) {
          setState({ kind: "not_found" });
        } else {
          setState({ kind: "error", message: describeError(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Settlement batch not found</h1>
        <p>
          No settlement batch with this id exists on your account.{" "}
          <Link to="/dashboard/settlement">Back to settlement batches</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Settlement batch</h1>
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }

  const { batch } = state;
  // Whole-number percent of a 1,000 BHD (1,000,000 fils) bar, computed from integer fils for display only.
  const displayProgress = Math.max(0, Math.min(100, Math.floor(batch.grossFils / 10000)));

  return (
    <section>
      <h1>Settlement batch {batch.batchDate}</h1>
      {batch.status === "closed" && (
        <div className="dash-progress-bar" style={{ width: "100%", background: "#e0e0e0", height: 6, borderRadius: 3 }}>
          <div style={{ width: `${displayProgress}%`, background: "#2563eb", height: 6, borderRadius: 3 }} />
        </div>
      )}
      <p className="dash-muted">
        <code>{batch.id}</code>
      </p>

      <dl className="dash-dl">
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${batch.status}`}>{batch.status}</span>
        </dd>
        <dt>Gross</dt>
        <dd>{bhd(batch.grossFils)}</dd>
        <dt>Fee</dt>
        <dd>{bhd(batch.feeFils)}</dd>
        <dt>Net payout</dt>
        <dd>{bhd(batch.netPayoutFils)}</dd>
        <dt>Closed at</dt>
        <dd>{dateTime(batch.closedAt)}</dd>
        <dt>Paid at</dt>
        <dd>{dateTime(batch.paidAt)}</dd>
        <dt>Included transactions</dt>
        <dd>{batch.includedTransactionCount}</dd>
        <dt>Capture events in this batch</dt>
        <dd>
          {batch.includedEventCount}
          {batch.includedEventCount !== batch.includedTransactionCount ? (
            <span className="dash-muted">
              {" "}
              — more events than transactions is normal: a transaction captured
              more than once in this window contributes one export line and
              several events.
            </span>
          ) : null}
        </dd>
      </dl>

      <h2>Included transactions</h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Line</th>
            <th>Transaction</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Authorized</th>
            <th>Captured</th>
            <th>Scheme amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.transactionId}-${line.lineSequence}`}>
              <td>{line.lineSequence}</td>
              <td>
                <Link to={`/dashboard/transactions/${line.transactionId}`}>
                  <code>{line.transactionId}</code>
                </Link>
              </td>
              <td>{dash(line.reference)}</td>
              <td>{statusLabel(line.status)}</td>
              <td>{bhd(line.authorizedFils)}</td>
              <td>{bhd(line.capturedFils)}</td>
              <td>{bhd(line.schemeAmountFils)}</td>
            </tr>
          ))}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={7}>No scheme export lines in this batch.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="dash-muted">
        The scheme amount is the card-network export figure, quantized to two
        decimal places at that boundary — it can be up to 9 fils below the
        captured amount by design.
      </p>

      <p>
        <Link to="/dashboard/settlement">Back to settlement batches</Link>
      </p>
    </section>
  );
}
