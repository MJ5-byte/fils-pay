import {
  ColumnHead,
  IconClock,
  IconCoins,
  IconHash,
  IconReceipt,
  IconSettlement,
  PageHeader,
  Skeleton, formatBusinessDate } from "@filspay/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSettlementBatch, getSettlementBatchTransactions } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { IconArrowLeft, IconScale } from "../../components/icons.js";
import { dash, dateTime } from "../../format.js";
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
 * discrepancy where there isn't one, or hide a real one.
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
        // 404, not 403, for another merchant's batch: the same non-disclosure
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

  if (state.kind === "loading") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Settlement batch" />
        <div className="fp-loading" aria-label="Loading" aria-busy="true"><Skeleton height={28} width="45%" /><Skeleton height={72} /><Skeleton height={72} /></div>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return <section className="fp-page fp-stagger">
      <PageHeader title="Settlement batch" back={<Link to="/dashboard/settlement"><IconArrowLeft /> Back</Link>} />
      <div className="dash-card"><EmptyState icon={IconSettlement}>No settlement batch with this id exists on your account.</EmptyState></div>
    </section>;
  }
  if (state.kind === "error") {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Settlement batch" />
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }

  const { batch } = state;
  const differingCounts = batch.includedEventCount !== batch.includedTransactionCount;

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title={`Batch ${formatBusinessDate(batch.batchDate)}`} status={<StatusBadge status={batch.status} />} back={<Link to="/dashboard/settlement"><IconArrowLeft /> Back</Link>} />

      <div className="dash-card">
        <div className="fp-detail-amount"><span>Net payout</span><Money fils={batch.netPayoutFils} size="hero" /></div>
        <dl className="dash-dl">
          <div className="dash-fact"><dt>Gross</dt>
            <dd>
              <Money fils={batch.grossFils} />
            </dd></div>
          <div className="dash-fact"><dt>Fee</dt>
            <dd>
              <Money fils={batch.feeFils} />
            </dd></div>

          <div className="dash-fact"><dt>Closed at</dt>
            <dd>{dateTime(batch.closedAt)}</dd></div>
          <div className="dash-fact"><dt>Paid at</dt>
            <dd>{dateTime(batch.paidAt)}</dd></div>
          <div className="dash-fact"><dt>Included transactions</dt>
            <dd>{batch.includedTransactionCount}</dd></div>
          <div className="dash-fact"><dt>Capture events in this batch</dt>
            <dd>
              {batch.includedEventCount}
              {differingCounts ? (
                <span className="dash-muted">
                  {" "}
                  (more events than transactions is normal: a transaction captured
                  more than once in this window contributes one export line and
                  several events).
                </span>
              ) : null}
            </dd></div>
        </dl>
      </div>

      <section className="fp-list-card"><div className="dash-card-head"><h2 className="dash-card-title">Included transactions</h2></div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th className="dash-rank"><ColumnHead icon={IconHash}>Line</ColumnHead></th>
                <th><ColumnHead icon={IconReceipt}>Transaction</ColumnHead></th>
                <th><ColumnHead icon={IconHash}>Reference</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Authorized</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Captured</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Scheme Amount</ColumnHead></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={`${line.transactionId}-${line.lineSequence}`}>
                  <td className="dash-rank">{line.lineSequence}</td>
                  <td>
                    <Link to={`/dashboard/transactions/${line.transactionId}`}>
                      <code>{line.transactionId}</code>
                    </Link>
                  </td>
                  <td>{dash(line.reference)}</td>
                  <td>
                    <StatusBadge status={line.status} />
                  </td>
                  <td className="dash-num">
                    <Money fils={line.authorizedFils} />
                  </td>
                  <td className="dash-num">
                    <Money fils={line.capturedFils} />
                  </td>
                  <td className="dash-num">
                    <Money fils={line.schemeAmountFils} />
                  </td>
                </tr>
              ))}
              {lines.length === 0 ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={7}>
                    <EmptyState icon={IconScale}>No scheme export lines in this batch.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <p className="dash-muted" style={{ marginTop: "var(--fp-3)" }}>
        The scheme amount is the card-network export figure, quantized to two
        decimal places at that boundary, so it can be up to 9 fils below the
        captured amount by design.
      </p>
    </section>
  );
}
