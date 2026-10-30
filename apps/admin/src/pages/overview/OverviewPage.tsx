import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMerchants } from "../../api/merchants.js";
import { listCreditRequests } from "../../api/credits.js";
import { listAdjustmentImports } from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import {
  KpiTile, PageHeader, ColumnHead, ColumnChart, StatusMixBar, Skeleton, SkeletonRows,
  IconCalendar, IconClock, IconCheck, IconRefreshCw,
  EmptyState,
  Money,
  StatusBadge,
  Tag,
  IconArrowLeft,
  IconCoins,
  IconDoc,
  IconLive,
  IconScale,
  IconSettlement,
  IconShield,
  IconUser,
  IconWebhooks, formatDate } from "@filspay/ui";
import type { AdminMerchantSummary, AdjustmentImportSummary, CreditRequestDto } from "../../types.js";

/** How many rows each queue preview fetches. A queue is something an operator
 *  works down, so the page shows the first page and says "+" when more remain,
 *  rather than paging the whole platform to print a total that would be stale
 *  the moment it rendered. */
const PAGE = 25;

/** A count that is honest about pagination: "7" when the page held them all,
 *  "25+" when the keyset cursor says more remain. */
function countLabel(shown: number, hasMore: boolean): string {
  return `${shown.toLocaleString("en")}${hasMore ? "+" : ""}`;
}

/** An enum value as words: `dispute_resolution` to `Dispute resolution`. */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `2026-10-29T...` to a short local date, for a queue row's age. */
function shortDate(iso: string): string {
  return formatDate(iso);
}

interface OverviewData {
  readonly merchants: readonly AdminMerchantSummary[];
  readonly merchantsMore: boolean;
  readonly recentCredits: readonly CreditRequestDto[];
  readonly recentCreditsMore: boolean;
  readonly imports: readonly AdjustmentImportSummary[];
  readonly importsMore: boolean;
  readonly merchantNames: ReadonlyMap<string, string>;
  readonly awaiting: readonly AdminMerchantSummary[];
  readonly awaitingMore: boolean;
  readonly pendingCredits: readonly CreditRequestDto[];
  readonly pendingCreditsMore: boolean;
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The overview uses existing cross-merchant lists, with their page limits.
      const [merchants, credits, allMerchants, recentCredits, imports] = await Promise.all([
        listMerchants({ onboardingStatus: ["submitted", "under_review"], limit: PAGE }),
        listCreditRequests({ status: "pending_approval", limit: PAGE }),
        listMerchants({ limit: 100 }),
        listCreditRequests({ limit: 25 }),
        listAdjustmentImports({ limit: 10 }),
      ]);
      const merchantNames = new Map([...allMerchants.merchants, ...merchants.merchants].map(m => [m.id, m.displayName]));
      setData({
        merchants: allMerchants.merchants,
        merchantsMore: allMerchants.nextCursor !== null,
        recentCredits: recentCredits.items,
        recentCreditsMore: recentCredits.nextCursor !== null,
        imports: imports.items,
        importsMore: imports.nextCursor !== null,
        merchantNames,
        awaiting: merchants.merchants,
        awaitingMore: merchants.nextCursor !== null,
        pendingCredits: credits.items,
        pendingCreditsMore: credits.nextCursor !== null,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const awaiting = data?.awaiting ?? [];
  const pendingCredits = data?.pendingCredits ?? [];

  const merchants = data?.merchants ?? [];
  const recentCredits = data?.recentCredits ?? [];
  const imports = data?.imports ?? [];
  const onboardingStatuses = [...new Set(merchants.map(m => m.onboardingStatus))]
    .map(status => ({ status, count: merchants.filter(m => m.onboardingStatus === status).length }));
  const liveCount = merchants.filter(m => !m.testMode).length;
  const testCount = merchants.filter(m => m.testMode).length;
  const creditValue = pendingCredits.reduce((sum, credit) => sum + credit.baseAmountFils, 0);
  const passedKyc = awaiting.filter(merchant => merchant.kycPassed);
  const queueDays = Array.from(new Set([...awaiting, ...pendingCredits].map(item => item.createdAt.slice(0, 10)))).sort();
  const merchantSeries = queueDays.map(day => awaiting.filter(item => item.createdAt.startsWith(day)).length);
  const creditSeries = queueDays.map(day => pendingCredits.filter(item => item.createdAt.startsWith(day)).length);
  const creditValues = queueDays.map(day => pendingCredits.filter(item => item.createdAt.startsWith(day)).reduce((sum, item) => sum + item.baseAmountFils, 0));
  const creditColumns = pendingCredits.length === 0 ? [] : queueDays.map((day, index) => ({ key: day, label: day.slice(5), tooltipLabel: day, segments: [{ name: "Pending credits", value: creditValues[index] ?? 0, color: "var(--fp-brand)" }] }));

  if (error && !data) {
    return <section className="fp-overview">
      <PageHeader title="Overview" actions={<button type="button" className="dash-button dash-button-primary" onClick={() => void load()} disabled={loading}>Retry</button>} />
      <p className="dash-error">{error}</p>
    </section>;
  }

  return (
    <section className="fp-overview fp-stagger">
      <PageHeader title="Overview" lede="Merchant activity, review queues, credit decisions and recent adjustment imports." actions={
        <button type="button" className="dash-button dash-button-primary" onClick={() => void load()} disabled={loading}>
          <IconRefreshCw />{loading ? "Refreshing" : "Refresh"}
        </button>
      } />

      {error ? <p className="dash-error">{error}</p> : null}

      <div className="dash-metrics fp-stagger">
        <KpiTile tone="ink" icon={IconUser} label="Merchants" value={merchants.length} format={value => countLabel(value, data?.merchantsMore ?? false)} foot="shown across all onboarding statuses" loading={loading && !data} />
        <KpiTile icon={IconUser} label="Merchants awaiting review" value={awaiting.length} format={value => countLabel(value, data?.awaitingMore ?? false)} foot="submitted or under review" loading={loading && !data} series={merchantSeries} seriesLabel="Shown merchants by creation date" />
        <KpiTile icon={IconCoins} label="Credit approvals pending" value={pendingCredits.length} format={value => countLabel(value, data?.pendingCreditsMore ?? false)} foot="awaiting a finance decision" loading={loading && !data} series={creditSeries} seriesLabel="Shown credit requests by creation date" />
        <KpiTile icon={IconScale} label="Pending credit value" value={creditValue} format={value => <Money fils={value} />} foot={pendingCredits.length === 0 ? "no requests pending" : `across the ${countLabel(pendingCredits.length, false)} shown${data?.pendingCreditsMore ? ", more remain" : ""}`} loading={loading && !data} series={creditValues} seriesLabel="Shown pending credit value by creation date" />
      </div>

      <div className="fp-overview-grid fp-stagger">
        <section className="dash-card">
          {loading && !data ? <Skeleton height={292} /> : creditColumns.length > 0 ? <>
            <div className="dash-card-head"><div><h2>Pending credit value</h2><p className="fp-widget-description">Shown requests by creation date</p></div></div>
            <ColumnChart columns={creditColumns} caption="Pending credit value by request creation date" />
          </> : <>
            <div className="dash-card-head"><div><h2>Merchant roster</h2><p className="fp-widget-description">No credits pending, so every merchant shown instead</p></div></div>
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead><tr>
                  <th><ColumnHead icon={IconUser}>Merchant</ColumnHead></th>
                  <th><ColumnHead icon={IconClock}>Onboarding</ColumnHead></th>
                  <th><ColumnHead icon={IconLive}>Mode</ColumnHead></th>
                  <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
                </tr></thead>
                <tbody>
                  {merchants.slice(0, 8).map(m => <tr key={m.id}>
                    <td><Link to={`/merchants/${m.id}`}>{m.displayName}</Link></td>
                    <td><StatusBadge status={m.onboardingStatus} /></td>
                    <td>{m.testMode ? "Test" : "Live"}</td>
                    <td>{shortDate(m.createdAt)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {merchants.length > 8 ? <p className="dash-muted"><Link to="/merchants">See all merchants</Link></p> : null}
          </>}
        </section>
        <section className="dash-card">
          <div className="dash-card-head"><div><h2>Merchants</h2><p className="fp-widget-description">Onboarding status of shown merchants</p></div></div>
          {loading && !data ? <Skeleton height={64} /> : <StatusMixBar items={onboardingStatuses} caption="Shown merchants by onboarding status" />}
          <div className="fp-queue-summary">
            <div className="fp-queue-row"><span>Review queue, KYC passed</span><strong>{countLabel(passedKyc.length, false)}</strong></div>
            <div className="fp-queue-row"><span>Live merchants shown</span><strong>{countLabel(liveCount, false)}</strong></div>
            <div className="fp-queue-row"><span>Test-mode merchants shown</span><strong>{countLabel(testCount, false)}</strong></div>
          </div>
        </section>
      </div>

      <section className="fp-table-section">
      <div className="dash-card-head"><h2>Merchants awaiting review</h2></div>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th><ColumnHead icon={IconUser}>Merchant</ColumnHead></th>
              <th><ColumnHead icon={IconClock}>Onboarding</ColumnHead></th>
              <th><ColumnHead icon={IconCheck}>Standing</ColumnHead></th>
              <th><ColumnHead icon={IconShield}>KYC</ColumnHead></th>
              <th><ColumnHead icon={IconLive}>Mode</ColumnHead></th>
              <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
            </tr>
          </thead>
          {loading && !data ? <SkeletonRows rows={3} columns={6} /> : (
          <tbody>
            {awaiting.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link to={`/merchants/${m.id}`}>{m.displayName}</Link>
                </td>
                <td>
                  <StatusBadge status={m.onboardingStatus} />
                </td>
                <td>
                  <StatusBadge status={m.status} />
                </td>
                <td>
                  {m.kycPassed ? (
                    <Tag tone="pos" icon={IconShield}>
                      KYC passed
                    </Tag>
                  ) : (
                    <Tag tone="warn" icon={IconShield}>
                      KYC pending
                    </Tag>
                  )}
                </td>
                <td>
                  {m.testMode ? (
                    <Tag tone="neutral" icon={IconDoc}>
                      Test
                    </Tag>
                  ) : (
                    <Tag tone="pos" icon={IconLive}>
                      Live
                    </Tag>
                  )}
                </td>
                <td>{shortDate(m.createdAt)}</td>
              </tr>
            ))}
            {data && awaiting.length === 0 ? (
              <tr>
                <td className="dash-empty-cell" colSpan={6}>
                  <EmptyState icon={IconUser}>No merchants are waiting on a review.</EmptyState>
                </td>
              </tr>
            ) : null}
          </tbody>
          )}
        </table>
      </div>
      {data?.awaitingMore ? (
        <p className="dash-muted">
          <Link to="/merchants">See all merchants</Link>
        </p>
      ) : null}

      </section>
      <section className="fp-table-section">
      <div className="dash-card-head"><h2>Credit approvals pending</h2></div>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th><ColumnHead icon={IconUser}>Merchant</ColumnHead></th>
              <th><ColumnHead icon={IconDoc}>Reason</ColumnHead></th>
              <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Amount</ColumnHead></th>
              <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
              <th><ColumnHead icon={IconUser}>Requested By</ColumnHead></th>
              <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
            </tr>
          </thead>
          {loading && !data ? <SkeletonRows rows={3} columns={6} /> : (
          <tbody>
            {pendingCredits.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/merchants/${c.merchantId}`}>{data?.merchantNames.get(c.merchantId) ?? "Open merchant"}</Link>
                </td>
                <td>{humanize(c.reasonCode)}</td>
                <td className="dash-num">
                  <Money fils={c.baseAmountFils} />
                </td>
                <td>
                  <StatusBadge status={c.status} />
                </td>
                <td>{c.requestedByDisplayName}</td>
                <td>{shortDate(c.createdAt)}</td>
              </tr>
            ))}
            {data && pendingCredits.length === 0 ? (
              <tr>
                <td className="dash-empty-cell" colSpan={6}>
                  <EmptyState icon={IconCoins}>No credit requests are awaiting approval.</EmptyState>
                </td>
              </tr>
            ) : null}
          </tbody>
          )}
        </table>
      </div>
      {data?.pendingCreditsMore ? (
        <p className="dash-muted">
          <Link to="/credits">See all credit requests</Link>
        </p>
      ) : null}

      </section>
      <section className="fp-table-section">
        <div className="dash-card-head"><h2>Recent credit requests</h2></div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead><tr>
              <th><ColumnHead icon={IconUser}>Merchant</ColumnHead></th>
              <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Amount</ColumnHead></th>
              <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
              <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
            </tr></thead>
            {loading && !data ? <SkeletonRows rows={3} columns={4} /> : <tbody>
              {recentCredits.map(credit => <tr key={credit.id}>
                <td><Link to={`/merchants/${credit.merchantId}`}>{data?.merchantNames.get(credit.merchantId) ?? "Open merchant"}</Link></td>
                <td className="dash-num"><Money fils={credit.baseAmountFils} /></td>
                <td><StatusBadge status={credit.status} /></td>
                <td>{shortDate(credit.createdAt)}</td>
              </tr>)}
              {data && recentCredits.length === 0 ? <tr><td className="dash-empty-cell" colSpan={4}>
                <EmptyState icon={IconCoins}>No credit requests yet.</EmptyState>
              </td></tr> : null}
            </tbody>}
          </table>
        </div>
        {data?.recentCreditsMore ? <p className="dash-muted"><Link to="/credits">See all credit requests</Link></p> : null}
      </section>
      <section className="fp-table-section">
        <div className="dash-card-head"><h2>Recent adjustment imports</h2></div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead><tr>
              <th><ColumnHead icon={IconDoc}>File</ColumnHead></th>
              <th className="dash-num"><ColumnHead icon={IconCheck} align="right">Rows</ColumnHead></th>
              <th><ColumnHead icon={IconCalendar}>Applied</ColumnHead></th>
            </tr></thead>
            {loading && !data ? <SkeletonRows rows={3} columns={3} /> : <tbody>
              {imports.map(item => <tr key={item.id}>
                <td><Link to="/adjustment-imports">{item.originalFilename}</Link></td>
                <td className="dash-num">{countLabel(item.rowCount, false)}</td>
                <td>{shortDate(item.appliedAt)}</td>
              </tr>)}
              {data && imports.length === 0 ? <tr><td className="dash-empty-cell" colSpan={3}>
                <EmptyState icon={IconDoc}>No adjustment imports yet.</EmptyState>
              </td></tr> : null}
            </tbody>}
          </table>
        </div>
        {data?.importsMore ? <p className="dash-muted"><Link to="/adjustment-imports">See all adjustment imports</Link></p> : null}
      </section>
      <section className="dash-card">
      <div className="dash-card-head"><h2>Operator tools</h2></div>
      <div className="admin-tools">
        <Link className="dash-button dash-button-ghost" to="/settlement">
          <IconSettlement />
          Settlement ops
        </Link>
        <Link className="dash-button dash-button-ghost" to="/adjustment-imports">
          <IconDoc />
          Import adjustments
        </Link>
        <Link className="dash-button dash-button-ghost" to="/webhooks">
          <IconWebhooks />
          Webhook replay
        </Link>
        <Link className="dash-button dash-button-ghost" to="/merchants">
          <IconArrowLeft />
          All merchants
        </Link>
      </div>
      </section>
    </section>
  );
}
