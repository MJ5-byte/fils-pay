import {
  ColumnHead,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoins,
  IconHash,
  IconPercent,
  IconScale,
  IconStore,
  IconWallet,
  Money,
  PageHeader,
  StatusBadge,
  Tag, formatBusinessDate } from "@filspay/ui";
import { useState } from "react";

import { rebuildAnalytics, rebuildBalances, runBatch } from "../../api/settlement.js";
import { recalculateMdr } from "../../api/mdrRecalculation.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { yesterdayIso } from "./businessDate.js";
import type {
  AnalyticsRebuildSummary,
  BalanceRebuildSummary,
  MdrRecalcSummary,
  RunBatchSummary,
} from "../../types.js";

/**
 * The two cross-process operations. Both are `finance` /
 * `super_admin` server-side; both write their audit row *before* the call
 * crosses the network, so an attempt is on record even if the settlement
 * service never answers.
 *
 * The analytics rebuild at the bottom is the same role gate and the same
 * confirm-before-you-run shape, but it never leaves apps/api, it is one
 * transaction of SQL, so its audit row is simply part of that transaction.
 */
export function SettlementPage() {
  const [date, setDate] = useState(yesterdayIso());
  const [merchantId, setMerchantId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunBatchSummary | null>(null);

  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<BalanceRebuildSummary | null>(null);

  const [confirmingAnalytics, setConfirmingAnalytics] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsRebuildSummary | null>(null);

  const [mdrMerchantId, setMdrMerchantId] = useState("");
  const [mdrFrom, setMdrFrom] = useState("");
  const [mdrTo, setMdrTo] = useState("");
  const [mdrBusy, setMdrBusy] = useState(false);
  const [mdrError, setMdrError] = useState<string | null>(null);
  const [mdrResult, setMdrResult] = useState<MdrRecalcSummary | null>(null);

  /** Idempotent per business date: re-running returns the already-closed batches. */
  async function handleRunBatch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(
        await runBatch({ date, merchantId: merchantId.trim() ? merchantId.trim() : undefined }),
      );
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setRunBusy(false);
    }
  }

  // after clicking rebuild on staging alpha's balance jumped to like 3x??, am
  // MK: staging data is junk. cache-only, safe to click
  async function handleRebuild(): Promise<void> {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildResult(null);
    try {
      setRebuildResult(await rebuildBalances());
      setConfirmingRebuild(false);
    } catch (err) {
      setRebuildError(describeError(err));
    } finally {
      setRebuildBusy(false);
    }
  }

  async function handleRebuildAnalytics(): Promise<void> {
    setAnalyticsBusy(true);
    setAnalyticsError(null);
    setAnalyticsResult(null);
    try {
      setAnalyticsResult(await rebuildAnalytics());
      setConfirmingAnalytics(false);
    } catch (err) {
      setAnalyticsError(describeError(err));
    } finally {
      setAnalyticsBusy(false);
    }
  }

  // FH: ADMIN.md says this is safe
  async function handleRecalculateMdr(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setMdrBusy(true);
    setMdrError(null);
    setMdrResult(null);
    try {
      setMdrResult(await recalculateMdr(mdrMerchantId.trim(), { from: mdrFrom, to: mdrTo }));
    } catch (err) {
      setMdrError(describeError(err));
    } finally {
      setMdrBusy(false);
    }
  }

  const runResults = runResult?.merchantResults ?? [];
  const runFailures = runResult?.failedMerchants ?? [];
  const mdrAdjusted = mdrResult?.adjusted ?? [];

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Settlement ops" lede="Finance tools. Every run is written to the audit log first." />

      <div className="fp-section-grid fp-stagger">
        <section className="dash-card fp-section"><h2>Re-run a daily batch</h2>
          <p className="dash-muted">
            Closes and pays out the batch for one business date. Running a date that is already closed or
            paid is safe, the settlement service reports it as already-done rather than doing it twice.
          </p>

          {runError ? <p className="dash-error">{runError}</p> : null}

          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role cannot trigger settlement runs. Ask a finance admin.
              </p>
            }
          >
            <form className="dash-form" onSubmit={(e) => void handleRunBatch(e)}>
              <label>
                Business date
                <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label>
                Merchant ID (optional)
                <input
                  type="text"
                  placeholder="Blank runs every merchant"
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                />
              </label>
              <button className="dash-button dash-button-primary" type="submit" disabled={runBusy}>
                {runBusy ? "Running..." : "Run batch"}
              </button>
            </form>
          </RequireRole>

          {runResult ? (
            <div className="dash-notice">
              <p>
                Batch run for <strong>{runResult.businessDate}</strong>, {runResults.length} merchant
                {runResults.length === 1 ? "" : "s"} processed.
              </p>
              {runFailures.length > 0 ? (
                <p className="dash-error">
                  {runFailures.length} merchant{runFailures.length === 1 ? "" : "s"} failed to settle:{" "}
                  {runFailures.map((failure, index) => (
                    <span key={failure.merchantId}>
                      {index > 0 ? ", " : ""}<code>{failure.merchantId}</code>
                    </span>
                  ))}
                  {" "}Rerunning this date is safe: merchants already settled are skipped.
                </p>
              ) : null}
              {runResults.length > 0 ? (
                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th><ColumnHead icon={IconStore}>Merchant</ColumnHead></th>
                        <th><ColumnHead icon={IconHash}>Batch</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Gross</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconPercent} align="right">Fee</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconWallet} align="right">Net Payout</ColumnHead></th>
                        <th><ColumnHead icon={IconCheck}>Already Closed</ColumnHead></th>
                        <th><ColumnHead icon={IconCheck}>Already Paid</ColumnHead></th>
                      </tr>
                    </thead>
                    <tbody>
                      {runResults.map((outcome) => (
                        <tr key={`${outcome.merchantId}-${outcome.batchId}`}>
                          <td>
                            <code>{outcome.merchantId}</code>
                          </td>
                          <td>
                            <code>{outcome.batchId}</code>
                          </td>
                          <td className="dash-num">
                            <Money fils={outcome.grossFils} />
                          </td>
                          <td className="dash-num">
                            <Money fils={outcome.feeFils} />
                          </td>
                          <td className="dash-num">
                            <Money fils={outcome.netPayoutFils} />
                          </td>
                          <td>
                            {outcome.alreadyClosed ? (
                              <Tag tone="pos" icon={IconCheck}>Yes</Tag>
                            ) : (
                              <Tag tone="neutral" icon={IconClock}>No</Tag>
                            )}
                          </td>
                          <td>
                            {outcome.alreadyPaid ? (
                              <Tag tone="pos" icon={IconCheck}>Yes</Tag>
                            ) : (
                              <Tag tone="neutral" icon={IconClock}>No</Tag>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}

        </section>
        <section className="dash-card fp-section"><h2>Rebuild cached balances</h2>
          <p className="dash-muted">
            Recomputes every merchant&apos;s cached payable balance as the net of their closed, unpaid
            settlement batches. Batches and the ledger are only read, never written, but this touches every
            merchant on the platform at once, so it asks before it runs.
          </p>

          {rebuildError ? <p className="dash-error">{rebuildError}</p> : null}

          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">Your role cannot rebuild balances. Ask a finance admin.</p>
            }
          >
            {confirmingRebuild ? (
              <div className="dash-confirm">
                <p>
                  <strong>Rebuild balances for every merchant?</strong> This recalculates all cached
                  payable balances and records the action in the admin audit log.
                </p>
                <button className="dash-button dash-button-primary" type="button" disabled={rebuildBusy} onClick={() => void handleRebuild()}>
                  {rebuildBusy ? "Rebuilding..." : "Yes, rebuild all balances"}
                </button>{" "}
                <button className="dash-button dash-button-ghost" type="button" disabled={rebuildBusy} onClick={() => setConfirmingRebuild(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="dash-button" type="button" onClick={() => setConfirmingRebuild(true)}>
                Rebuild balances
              </button>
            )}
          </RequireRole>

          {rebuildResult ? (
            <div className="dash-notice">
              <p>
                Rebuilt {rebuildResult.rebuiltCount} balance
                {rebuildResult.rebuiltCount === 1 ? "" : "s"};{" "}
                {(rebuildResult.changed ?? []).length} changed.
              </p>
              {(rebuildResult.changed ?? []).length > 0 ? (
                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th><ColumnHead icon={IconStore}>Merchant</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Before</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconCoins} align="right">After</ColumnHead></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rebuildResult.changed ?? []).map((change) => (
                        <tr key={change.merchantId}>
                          <td>
                            <code>{change.merchantId}</code>
                          </td>
                          <td className="dash-num">
                            <Money fils={change.before} />
                          </td>
                          <td className="dash-num">
                            <Money fils={change.after} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="dash-muted">Every cached balance already matched its closed, unpaid batches.</p>
              )}
            </div>
          ) : null}

        </section>
        <section className="dash-card fp-section"><h2>Rebuild analytics</h2>
          <p className="dash-muted">
            Rebuilds the analytics read model, daily volumes and payout trends, from scratch, for
            when a merchant reports their dashboard numbers looking wrong. It empties both rollups and
            the reporting worker replays every event into them again. Like the balance rebuild above, it
            touches every merchant at once, so it asks before it runs.
          </p>

          {analyticsError ? <p className="dash-error">{analyticsError}</p> : null}

          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">Your role cannot rebuild analytics. Ask a finance admin.</p>
            }
          >
            {confirmingAnalytics ? (
              <div className="dash-confirm">
                <p>
                  <strong>Rebuild analytics for every merchant?</strong> Dashboards show partial numbers
                  until the reporting worker's replay catches up. The action is recorded in the admin audit log.
                </p>
                <button
                  className="dash-button dash-button-primary"
                  type="button"
                  disabled={analyticsBusy}
                  onClick={() => void handleRebuildAnalytics()}
                >
                  {analyticsBusy ? "Rebuilding..." : "Yes, rebuild analytics"}
                </button>{" "}
                <button
                  className="dash-button dash-button-ghost"
                  type="button"
                  disabled={analyticsBusy}
                  onClick={() => setConfirmingAnalytics(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button className="dash-button" type="button" onClick={() => setConfirmingAnalytics(true)}>
                Rebuild analytics
              </button>
            )}
          </RequireRole>

          {analyticsResult ? (
            <div className="dash-notice">
              <p>Analytics cleared. The reporting worker is replaying the outbox into them now.</p>
            </div>
          ) : null}

        </section>
        <section className="dash-card fp-section"><h2>Recalculate MDR</h2>
          <p className="dash-muted">
            Re-derives one merchant&apos;s settlement-batch fees over a date range at their current
            contracted rate, and posts a ledger adjustment for any difference. Finance runs this after a
            rate change lands so historical batches reflect the same figure a fresh reconciliation would
            show.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role cannot run an MDR recalculation. Ask a finance admin.
              </p>
            }
          >
            <form className="dash-form" onSubmit={(e) => void handleRecalculateMdr(e)}>
              <label>
                Merchant id
                <input
                  value={mdrMerchantId}
                  onChange={(e) => setMdrMerchantId(e.target.value)}
                  placeholder="Merchant ID"
                  required
                />
              </label>
              <label>
                From (inclusive)
                <input type="date" value={mdrFrom} onChange={(e) => setMdrFrom(e.target.value)} required />
              </label>
              <label>
                To (exclusive)
                <input type="date" value={mdrTo} onChange={(e) => setMdrTo(e.target.value)} required />
              </label>
              <button className="dash-button dash-button-primary" type="submit" disabled={mdrBusy}>
                {mdrBusy ? "Recalculating…" : "Recalculate MDR"}
              </button>
            </form>
          </RequireRole>

          {mdrError ? <p className="dash-error">{mdrError}</p> : null}

          {mdrResult ? (
            <div>
              <p>
                Considered {mdrResult.batchesConsidered} batch(es); {mdrAdjusted.length} had a fee
                change.
              </p>
              {mdrAdjusted.length > 0 ? (
                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th><ColumnHead icon={IconCalendar}>Batch Date</ColumnHead></th>
                        <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconPercent} align="right">Old Fee</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconPercent} align="right">New Fee</ColumnHead></th>
                        <th className="dash-num"><ColumnHead icon={IconScale} align="right">Difference</ColumnHead></th>
                      </tr>
                    </thead>
                    <tbody>
                      {mdrAdjusted.map((adjustment) => (
                        <tr key={adjustment.batchId}>
                          <td>{formatBusinessDate(adjustment.batchDate)}</td>
                          <td>
                            <StatusBadge status={adjustment.status} />
                          </td>
                          <td className="dash-num">
                            <Money fils={adjustment.oldFeeFils} />
                          </td>
                          <td className="dash-num">
                            <Money fils={adjustment.newFeeFils} />
                          </td>
                          <td className="dash-num">
                            <Money fils={adjustment.diffFils} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="dash-muted">Every batch in range already matched the current rate.</p>
              )}
            </div>
          ) : null}
        </section></div>
    </section>
  );
}
