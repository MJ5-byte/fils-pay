import { useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
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

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

/**
 * The two cross-process operations. Both are `finance` /
 * `super_admin` server-side; both write their audit row *before* the call
 * crosses the network, so an attempt is on record even if the settlement
 * service never answers.
 *
 * The analytics rebuild at the bottom is the same role gate and the same
 * confirm-before-you-run shape, but it never leaves apps/api — it is one
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

  // after clicking rebuild on staging alpha's balance jumped to like 3x?? — am
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
  const mdrAdjusted = mdrResult?.adjusted ?? [];

  return (
    <section>
      <h1>Settlement ops</h1>
      <p className="admin-muted">
        Every action below is money-adjacent and is gated server-side to the <code>finance</code>{" "}
        and <code>super_admin</code> roles. Every invocation is written to the admin audit log before
        it runs.
      </p>

      <h2>Re-run a daily batch</h2>
      <p className="admin-muted">
        Closes and pays out the batch for one business date. Running a date that is already closed or
        paid is safe — the settlement service reports it as already-done rather than doing it twice.
      </p>

      {runError ? <p className="admin-error">{runError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role cannot trigger settlement runs. Ask a finance admin.
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleRunBatch(e)}>
          <label>
            Business date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Merchant id (optional — leave blank to run every eligible merchant)
            <input
              type="text"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            />
          </label>
          <button type="submit" disabled={runBusy}>
            {runBusy ? "Running..." : "Run batch"}
          </button>
        </form>
      </RequireRole>

      {runResult ? (
        <div className="admin-notice">
          <p>
            Batch run for <strong>{runResult.businessDate}</strong> — {runResults.length} merchant
            {runResults.length === 1 ? "" : "s"} processed.
          </p>
          {runResults.length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Batch</th>
                  <th>Gross</th>
                  <th>Fee</th>
                  <th>Net payout</th>
                  <th>Already closed</th>
                  <th>Already paid</th>
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
                    <td>{bhd(outcome.grossFils)}</td>
                    <td>{bhd(outcome.feeFils)}</td>
                    <td>{bhd(outcome.netPayoutFils)}</td>
                    <td>{outcome.alreadyClosed ? "yes" : "no"}</td>
                    <td>{outcome.alreadyPaid ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <h2>Rebuild cached balances</h2>
      <p className="admin-muted">
        Recomputes every merchant&apos;s cached payable balance from <code>ledger_entries</code>, the
        authoritative record. The ledger itself is only read, never written — but this touches every
        merchant on the platform at once, so it asks before it runs.
      </p>

      {rebuildError ? <p className="admin-error">{rebuildError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">Your role cannot rebuild balances. Ask a finance admin.</p>
        }
      >
        {confirmingRebuild ? (
          <div className="admin-confirm">
            <p>
              <strong>Rebuild balances for every merchant?</strong> This recalculates all cached
              payable balances and records the action in the admin audit log.
            </p>
            <button type="button" disabled={rebuildBusy} onClick={() => void handleRebuild()}>
              {rebuildBusy ? "Rebuilding..." : "Yes, rebuild all balances"}
            </button>{" "}
            <button type="button" disabled={rebuildBusy} onClick={() => setConfirmingRebuild(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingRebuild(true)}>
            Rebuild balances
          </button>
        )}
      </RequireRole>

      {rebuildResult ? (
        <div className="admin-notice">
          <p>
            Rebuilt {rebuildResult.rebuiltCount} balance
            {rebuildResult.rebuiltCount === 1 ? "" : "s"};{" "}
            {(rebuildResult.changed ?? []).length} changed.
          </p>
          {(rebuildResult.changed ?? []).length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {(rebuildResult.changed ?? []).map((change) => (
                  <tr key={change.merchantId}>
                    <td>
                      <code>{change.merchantId}</code>
                    </td>
                    <td>{bhd(change.before)}</td>
                    <td>{bhd(change.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="admin-muted">Every cached balance already matched the ledger.</p>
          )}
        </div>
      ) : null}

      <h2>Rebuild analytics</h2>
      <p className="admin-muted">
        Rebuilds the analytics read model — daily volumes and payout trends — from scratch, for
        when a merchant reports their dashboard numbers looking wrong: it empties both rollups and
        the reporting worker replays every event into them again. Like the balance rebuild above, it
        touches every merchant at once, so it asks before it runs.
      </p>

      {analyticsError ? <p className="admin-error">{analyticsError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">Your role cannot rebuild analytics. Ask a finance admin.</p>
        }
      >
        {confirmingAnalytics ? (
          <div className="admin-confirm">
            <p>
              <strong>Rebuild analytics for every merchant?</strong> Dashboards show partial numbers
              until the reporting worker's replay catches up. The action is recorded in the admin audit log.
            </p>
            <button
              type="button"
              disabled={analyticsBusy}
              onClick={() => void handleRebuildAnalytics()}
            >
              {analyticsBusy ? "Rebuilding..." : "Yes, rebuild analytics"}
            </button>{" "}
            <button
              type="button"
              disabled={analyticsBusy}
              onClick={() => setConfirmingAnalytics(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingAnalytics(true)}>
            Rebuild analytics
          </button>
        )}
      </RequireRole>

      {analyticsResult ? (
        <div className="admin-notice">
          <p>Analytics cleared. The reporting worker is replaying the outbox into them now.</p>
        </div>
      ) : null}

      <h2>Recalculate MDR</h2>
      <p className="admin-muted">
        Re-derives one merchant&apos;s settlement-batch fees over a date range at their current
        contracted rate, and posts a ledger adjustment for any difference. Finance runs this after a
        rate change lands so historical batches reflect the same figure a fresh reconciliation would
        show.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role cannot run an MDR recalculation. Ask a finance admin.
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleRecalculateMdr(e)}>
          <label>
            Merchant id
            <input
              value={mdrMerchantId}
              onChange={(e) => setMdrMerchantId(e.target.value)}
              placeholder="merchant UUID"
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
          <button type="submit" disabled={mdrBusy}>
            {mdrBusy ? "Recalculating…" : "Recalculate MDR"}
          </button>
        </form>
      </RequireRole>

      {mdrError ? <p className="admin-error">{mdrError}</p> : null}

      {mdrResult ? (
        <div>
          <p>
            Considered {mdrResult.batchesConsidered} batch(es); {mdrAdjusted.length} had a fee
            change.
          </p>
          {mdrAdjusted.length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Batch date</th>
                  <th>Status</th>
                  <th>Old fee</th>
                  <th>New fee</th>
                  <th>Difference</th>
                </tr>
              </thead>
              <tbody>
                {mdrAdjusted.map((adjustment) => (
                  <tr key={adjustment.batchId}>
                    <td>{adjustment.batchDate}</td>
                    <td>{adjustment.status}</td>
                    <td>{bhd(adjustment.oldFeeFils)}</td>
                    <td>{bhd(adjustment.newFeeFils)}</td>
                    <td>{bhd(adjustment.diffFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="admin-muted">Every batch in range already matched the current rate.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
