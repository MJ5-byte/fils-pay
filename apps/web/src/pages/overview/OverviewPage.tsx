import {
  ColumnHead,
  IconBan,
  IconCalendar,
  IconCheck,
  IconClock,
  IconDoc,
  IconHash,
  IconLinks,
  IconPercent,
  IconRefreshCw,
  KpiTile,
  PageHeader,
  Skeleton,
  SkeletonRows, formatBusinessDate } from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPayoutTrends, getTopLinks, getVolumes } from "../../api/analytics.js";
import { describeError } from "../../api/client.js";
import { StalenessBadge } from "../../components/StalenessBadge.js";
import { Money } from "../../components/Money.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { AreaChart, ColumnChart, RankedBar, type ChartColumn } from "../../components/charts.js";
import { IconCoins, IconReceipt, IconStar, IconTrend } from "../../components/icons.js";
import { dash, dateTime } from "../../format.js";
import { formatCount } from "../../utils/helpers.js";
import type { PayoutTrendsResponse, TopLinksResponse, VolumesResponse } from "../../types.js";
import { DatePicker } from "../../components/DatePicker.js";

/** 60s: comfortably above the reporting worker's 15s worst-case lag, and
 *  more than often enough for a dashboard. Poll, not push:
 *  there is no websocket or SSE anywhere in this platform, and this page does
 *  not introduce the first one. */
const POLL_MS = 60_000;

export function OverviewPage() {
  // Left blank, the server applies its own "last 30 Asia/Bahrain days"
  // default, the client does not compute a competing one.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [topLinksLimit, setTopLinksLimit] = useState(10);
  const [showAllDays, setShowAllDays] = useState(false);

  const [volumes, setVolumes] = useState<VolumesResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutTrendsResponse | null>(null);
  const [topLinks, setTopLinks] = useState<TopLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the server's own clamp so this page never displays a limit the
  // server would have silently overridden.
  const clampedLimit = Math.min(50, Math.max(1, Math.trunc(topLinksLimit) || 10));

  const load = useCallback(async () => {
    const range = { from: from || undefined, to: to || undefined };
    setLoading(true);
    setError(null);
    try {
      // Three independent endpoints, three independent fetches: there is no
      // combined route to call.
      const [v, p, t] = await Promise.all([
        getVolumes(range),
        getPayoutTrends(range),
        getTopLinks({ ...range, limit: clampedLimit }),
      ]);
      setVolumes(v);
      setPayouts(p);
      setTopLinks(t);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, clampedLimit]);

  // overview memory leak (heap +40mb/hr), pretty sure its these effects (am)
  // FH: profiled for 1h, heap flat. maybe it was a browser extension? open
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const volumePoints = volumes?.points ?? [];
  const recentDays = [...volumePoints].sort((a, b) => b.date.localeCompare(a.date));
  const visibleDays = showAllDays ? recentDays : recentDays.slice(0, 7);
  const payoutPoints = payouts?.points ?? [];
  const linkRows = topLinks?.links ?? [];

  const totalCapturedGross = volumePoints.reduce((sum, point) => sum + point.capturedGrossFils, 0);
  const totalCapturedCount = volumePoints.reduce((sum, point) => sum + point.capturedCount, 0);
  const totalVoidedCount = volumePoints.reduce((sum, point) => sum + point.voidedCount, 0);
  const totalNetPayout = payoutPoints.reduce((sum, point) => sum + point.netPayoutFils, 0);

  const volumeColumns: ChartColumn[] = volumePoints.map((point) => ({
    key: point.date,
    label: formatBusinessDate(point.date),
    tooltipLabel: point.date,
    segments: [{ name: "Captured gross", value: point.capturedGrossFils, color: "var(--fp-brand)" }],
  }));

  const payoutColumns: ChartColumn[] = payoutPoints.map((point) => ({
    key: point.settlementBatchId,
    label: formatBusinessDate(point.batchDate),
    tooltipLabel: point.batchDate,
    segments: [
      { name: "Net payout", value: point.netPayoutFils, color: "var(--fp-brand)" },
      { name: "Fee", value: point.feeFils, color: "var(--fp-ink)" },
    ],
  }));

  const topLinkMax = linkRows.reduce((max, link) => Math.max(max, link.amountFils), 0);

  if (error && !volumes && !payouts && !topLinks) {
    return <section className="fp-overview">
      <PageHeader title="Overview" actions={<button type="button" className="dash-button dash-button-primary" onClick={() => void load()} disabled={loading}>Retry</button>} />
      <p className="dash-error">{error}</p>
    </section>;
  }

  return (
    <section className="fp-overview fp-stagger">
      <PageHeader title="Overview" lede="Captured volume, settled payouts and your best-performing payment links." actions={
        <button type="button" className="dash-button dash-button-primary" onClick={() => void load()} disabled={loading}>
          <IconRefreshCw />{loading ? "Refreshing" : "Refresh"}
        </button>
      } toolbar={<div className="dash-toolbar">
        <label>
          From
          <DatePicker value={from} onChange={setFrom} />
        </label>
        <label>
          To (exclusive)
          <DatePicker value={to} onChange={setTo} />
        </label>
        <label>
          Top links
          <input
            type="number"
            min={1}
            max={50}
            value={topLinksLimit}
            onChange={(e) => setTopLinksLimit(Number(e.target.value))}
          />
        </label>

      </div>} />

      {error ? <p className="dash-error">{error}</p> : null}

      <div className="dash-metrics fp-stagger">
        <KpiTile tone="ink" icon={IconCoins} label="Captured gross" value={totalCapturedGross} format={(value) => <Money fils={value} />} foot="across the selected window" loading={loading && !volumes} series={volumePoints.map(point => point.capturedGrossFils)} />
        <KpiTile icon={IconReceipt} label="Captured count" value={totalCapturedCount} format={formatCount} foot={`${formatCount(totalVoidedCount)} voided`} loading={loading && !volumes} series={volumePoints.map(point => point.capturedCount)} />
        <KpiTile icon={IconTrend} label="Net payouts" value={totalNetPayout} format={(value) => <Money fils={value} />} foot="from closed settlement batches" loading={loading && !payouts} series={payoutPoints.map(point => point.netPayoutFils)} />
        <KpiTile icon={IconStar} label="Paid links" value={linkRows.length} format={formatCount} foot={linkRows.length === 0 ? "none paid in this window" : `top ${formatCount(clampedLimit)}, ranked by amount`} loading={loading && !topLinks} series={linkRows.map(link => link.amountFils)} seriesLabel="Paid link amounts in rank order" />
      </div>

      <div className="fp-overview-grid fp-stagger">
        <section className="dash-card">
          <div className="dash-card-head">
            <div><h2>Captured volume</h2><p className="fp-widget-description">Captured gross per day</p></div>
            {volumes ? <StalenessBadge readModelAsOf={volumes.readModelAsOf} live={volumes.live} /> : null}
          </div>
          {loading && !volumes ? <Skeleton height={292} /> : <AreaChart columns={volumeColumns} caption="Captured gross per day" />}
        </section>
        <section className="dash-card">
          <div className="dash-card-head">
            <div><h2>Payout trends</h2><p className="fp-widget-description">Net payout and fee per batch</p></div>
            {payouts ? <StalenessBadge readModelAsOf={payouts.readModelAsOf} live={payouts.live} /> : null}
          </div>
          {loading && !payouts ? <Skeleton height={292} /> : <ColumnChart columns={payoutColumns} caption="Net payout and fee per batch" />}
        </section>
      </div>

      <section className="fp-table-section">
        <div className="dash-card-head"><h2>Daily captures</h2>
          {volumePoints.length > 7 ? <button type="button" className="dash-button" aria-expanded={showAllDays}
            onClick={() => setShowAllDays(value => !value)}>
            {showAllDays ? "Show recent 7 days" : `Show all ${formatCount(volumePoints.length)} days`}
          </button> : null}
        </div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconCalendar}>Date</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCheck} align="right">Captured</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Gross</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconBan} align="right">Voided</ColumnHead></th>
                <th className="dash-num">Refunded</th>
                <th className="dash-num">Refund total</th>
              </tr>
            </thead>
            {loading && !volumes ? <SkeletonRows rows={3} columns={6} /> : (
              <tbody>
                {visibleDays.map((point) => (
                  <tr key={point.date}>
                    <td>{formatBusinessDate(point.date)}</td>
                    <td className="dash-num">{formatCount(point.capturedCount)}</td>
                    <td className="dash-num">
                      <Money fils={point.capturedGrossFils} />
                    </td>
                    <td className="dash-num">{formatCount(point.voidedCount)}</td>
                    <td className="dash-num">{formatCount(point.refundCount)}</td>
                    <td className="dash-num"><Money fils={point.refundGrossFils} /></td>
                  </tr>
                ))}
                {volumes && volumePoints.length === 0 ? (
                  <tr>
                    <td className="dash-empty-cell" colSpan={6}>
                      <EmptyState icon={IconCoins}>No captured volume in this window.</EmptyState>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>

      </section>
      <section className="fp-table-section">
        <div className="dash-card-head"><h2>Settled batches</h2></div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th><ColumnHead icon={IconCalendar}>Batch Date</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Gross</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconPercent} align="right">Fee</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconTrend} align="right">Net Payout</ColumnHead></th>
                <th><ColumnHead icon={IconCheck}>Paid</ColumnHead></th>
              </tr>
            </thead>
            {loading && !payouts ? <SkeletonRows rows={3} columns={6} /> : (
              <tbody>
                {payoutPoints.map((point) => (
                  <tr key={point.settlementBatchId}>
                    <td>
                      <Link to={`/dashboard/settlement/${point.settlementBatchId}`}>{formatBusinessDate(point.batchDate)}</Link>
                    </td>
                    <td>
                      <StatusBadge status={point.status} />
                    </td>
                    <td className="dash-num">
                      <Money fils={point.grossFils} />
                    </td>
                    <td className="dash-num">
                      <Money fils={point.feeFils} />
                    </td>
                    <td className="dash-num">
                      <Money fils={point.netPayoutFils} />
                    </td>
                    <td>{dateTime(point.paidAt)}</td>
                  </tr>
                ))}
                {payouts && payoutPoints.length === 0 ? (
                  <tr>
                    <td className="dash-empty-cell" colSpan={6}>
                      <EmptyState icon={IconTrend}>No settled batches in this window.</EmptyState>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>

      </section>
      <section className="fp-table-section">
        <div className="dash-card-head"><h2>Top paid links</h2>
          {topLinks ? <StalenessBadge readModelAsOf={topLinks.readModelAsOf} live={topLinks.live} /> : null}
        </div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th className="dash-rank"><ColumnHead icon={IconHash}>Rank</ColumnHead></th>
                <th><ColumnHead icon={IconLinks}>Reference</ColumnHead></th>
                <th><ColumnHead icon={IconDoc}>Description</ColumnHead></th>
                <th style={{ width: "22%" }}><ColumnHead icon={IconPercent}>Share</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Amount</ColumnHead></th>
                <th><ColumnHead icon={IconCalendar}>Paid At</ColumnHead></th>
              </tr>
            </thead>
            {loading && !topLinks ? <SkeletonRows rows={3} columns={6} /> : (
              <tbody>
                {linkRows.map((link, index) => (
                  <tr key={link.id}>
                    <td className="dash-rank">{formatCount(index + 1)}</td>
                    <td>
                      <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
                    </td>
                    <td>{dash(link.description)}</td>
                    <td>
                      <RankedBar value={link.amountFils} max={topLinkMax} />
                    </td>
                    <td className="dash-num">
                      <Money fils={link.amountFils} />
                    </td>
                    <td>{dateTime(link.paidAt)}</td>
                  </tr>
                ))}
                {topLinks && linkRows.length === 0 ? (
                  <tr>
                    <td className="dash-empty-cell" colSpan={6}>
                      <EmptyState icon={IconStar}>No paid payment links in this window.</EmptyState>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>
      </section>
    </section>
  );
}
