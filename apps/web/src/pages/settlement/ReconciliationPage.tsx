import {
  IconClock,
  IconScale,
  IconSettlement,
  IconWallet,
  KpiTile,
  PageHeader,
  Skeleton,
  StatusBadge,
  formatBusinessDate,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { getReconciliation, listSettlementBatches } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { Money } from "../../components/Money.js";
import { IconAlert, IconCheck } from "../../components/icons.js";
import type { ReconciliationReport } from "../../types.js";
import { DatePicker } from "../../components/DatePicker.js";

/**
 * `from`/`to` are required by this endpoint (`400 invalid_request` without
 * them), so the page arrives with a filled-in window rather than an empty form
 * that would 400 on first load. `to` is exclusive.
 *
 * The window is anchored to the Asia/Bahrain calendar date, not the viewer's
 * own, because that is the business day `settlement_batches.batch_date` is
 * keyed on, a browser in another timezone would otherwise default to a
 * window off by a day from the batches it's reconciling. Bahrain has observed
 * no DST since 1972, so a fixed +3h shift is exact; this is the same technique
 * apps/api's own analytics route uses.
 */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

function defaultRange(): { from: string; to: string } {
  const nowBahrain = Date.now() + BAHRAIN_OFFSET_MS;
  const day = (offsetDays: number): string =>
    new Date(nowBahrain + offsetDays * DAY_MS).toISOString().slice(0, 10);
  return { from: day(-30), to: day(1) };
}

// FH: 'explained: false' only shows when settlement is mid-run, a refresh fixes it
// YA: gap != 0 is real when a fee schedule changes mid-period
export function ReconciliationPage() {
  const initial = defaultRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function chooseRange() {
      let range = defaultRange();
      try {
        const { batches } = await listSettlementBatches({ limit: 1 });
        const latest = batches[0];
        if (latest) {
          const anchor = new Date(`${latest.batchDate}T00:00:00+03:00`).getTime() + BAHRAIN_OFFSET_MS;
          const day = (offset: number) => new Date(anchor + offset * DAY_MS).toISOString().slice(0, 10);
          range = { from: day(-30), to: day(1) };
        }
      } catch {
        // Use the current Bahrain range when the batch list is unavailable.
      }
      if (cancelled) return;
      setFrom(range.from);
      setTo(range.to);
      setApplied(range);
    }
    void chooseRange();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!applied) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      setReport(await getReconciliation(applied));
    } catch (err) {
      // The one page-specific error branch in this dashboard, because this is
      // the one merchant endpoint with a role gate narrower than "any
      // authenticated merchant user". A `support` user who typed or bookmarked
      // this URL gets a plain explanation, not a crash, not a blank
      // loading-forever state, and no retry.
      if (err instanceof ApiError && err.statusCode === 403) {
        setForbidden(true);
        setReport(null);
      } else {
        setError(describeError(err));
      }
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Reconciliation" />
        <p className="dash-error">
          You don&apos;t have permission to view this report. Ask an owner or
          finance user on your account.
        </p>
      </section>
    );
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Reconciliation" lede={<> Checks that every captured amount is accounted for in a batch or the pending queue. </>} />

      <form
        className="dash-form dash-form-inline fp-form-card"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ from, to });
        }}
      >
        <label>
          From
          <DatePicker required value={from} onChange={setFrom} />
        </label>
        <label>
          To (exclusive)
          <DatePicker required value={to} onChange={setTo} />
        </label>
        <button type="submit" className="dash-button dash-button-primary" disabled={loading}>
          {loading ? "Loading" : "Run report"}
        </button>
      </form>

      {error ? <p className="dash-error">{error}</p> : null}

      {report ? (
        <>
          {/* A nonzero gap is shown as a nonzero gap. This page never rounds
              it away, hides it behind a tolerance, or explains it as expected,
              the endpoint reports honestly and so does this. */}
          <section className="dash-card">
            <div className="dash-card-head"><h2 className="dash-card-title">Reconciliation result</h2>
              <StatusBadge status={report.explained ? "reconciled" : "gap"}>{report.explained ? "Reconciled, no gap" : <>Gap: <Money fils={report.gapFils} /></>}</StatusBadge>
            </div>
            <p className="fp-widget-description">{formatBusinessDate(report.periodFrom)} to {formatBusinessDate(report.periodTo)} (exclusive)</p>
          </section>
          <div className="dash-metrics fp-stagger">
            <KpiTile icon={IconWallet} label="Ledger payable"><Money fils={report.ledgerMerchantPayableNetFils} /></KpiTile>
            <KpiTile icon={IconSettlement} label="Batched payout"><Money fils={report.settlementNetPayoutFils} /></KpiTile>
            <KpiTile icon={IconClock} label="Not yet batched"><Money fils={report.pendingUnbatchedFils} /></KpiTile>
            <KpiTile icon={IconScale} label="Gap"><Money fils={report.gapFils} /></KpiTile>
          </div>

          <p className="dash-muted">
            Gap = ledger merchant payable − settlement net payout − pending
            unbatched. A zero gap means every captured amount is accounted for in
            either a settled batch or the pending queue.
          </p>
        </>
      ) : null}

      {loading && !report ? <div className="fp-loading" aria-label="Loading" aria-busy="true"><Skeleton height={28} width="45%" /><Skeleton height={72} /><Skeleton height={72} /></div> : null}
    </section>
  );
}
