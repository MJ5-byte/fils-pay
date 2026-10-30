import {
  ColumnFilter,
  ColumnHead,
  FilterOptionList,
  EmptyState,
  IconCalendar,
  IconClock,
  IconDoc,
  IconLive,
  IconPercent,
  IconSearch,
  IconShield,
  IconStore,
  IconUser,
  PageHeader,
  SkeletonRows,
  StatusBadge,
  Tag, formatDate } from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMerchants } from "../../api/merchants.js";
import { bulkApproveKyc } from "../../api/merchantsBulk.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";

import type { AdminMerchantSummary, MerchantOnboardingStatus } from "../../types.js";

const ONBOARDING_STATUSES: MerchantOnboardingStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
];

const PAGE_SIZE = 25;

/** The platform's one legitimately cross-merchant view. Searchable by
 *  display name / id / contact email, filterable by onboarding status, and
 *  keyset-paginated like every other list endpoint here. */
export function MerchantListPage() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [statuses, setStatuses] = useState<MerchantOnboardingStatus[]>([]);
  const [merchants, setMerchants] = useState<AdminMerchantSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listMerchants({
          q: appliedQuery || undefined,
          onboardingStatus: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        const page = result.merchants ?? [];
        setMerchants((previous) => (cursor ? [...previous, ...page] : page));
        setNextCursor(result.nextCursor ?? null);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [appliedQuery, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: MerchantOnboardingStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  function toggleSelected(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Header checkbox: select or clear every row currently loaded into the
   *  table, i.e. exactly what the operator can see under the active
   *  search/status filters. */
  function toggleSelectAllLoaded(): void {
    setSelectedIds((previous) =>
      previous.size === merchants.length ? new Set() : new Set(merchants.map((m) => m.id)),
    );
  }

  // only approves the under_review ones (filtered), am
  // FH: sends every selected id, the server doesn't check status
  async function approveSelected(): Promise<void> {
    setBulkBusy(true);
    setError(null);
    setBulkNotice(null);
    try {
      const result = await bulkApproveKyc([...selectedIds]);
      setBulkNotice(`Approved KYC for ${result.approvedCount} merchant(s).`);
      setSelectedIds(new Set());
      await load(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBulkBusy(false);
    }
  }

  const allLoadedSelected = merchants.length > 0 && selectedIds.size === merchants.length;

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Merchants" lede={<> Find merchants, review onboarding and manage KYC approvals. </>} />

      <div className="fp-list-card">
        <form
          className="dash-form dash-form-inline"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQuery(query.trim());
          }}
        >
          <label>
            Search
            <input
              type="search"
              placeholder="Display name, merchant id, or contact email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button className="dash-button dash-button-primary" type="submit"><IconSearch /> Search</button>
        </form>

        {error ? <p className="dash-error">{error}</p> : null}
        {bulkNotice ? <p className="dash-notice">{bulkNotice}</p> : null}

        {selectedIds.size > 0 ? (
          <div className="dash-form dash-form-inline">
            <span>{selectedIds.size} selected</span>
            <RequireRole allow={["finance", "super_admin"]}>
              <button className="dash-button dash-button-primary" type="button" disabled={bulkBusy} onClick={() => void approveSelected()}>
                Bulk approve KYC
              </button>
            </RequireRole>
            <button className="dash-button dash-button-ghost" type="button" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
              Clear selection
            </button>
          </div>
        ) : null}

        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all loaded merchants"
                    checked={allLoadedSelected}
                    disabled={merchants.length === 0}
                    onChange={toggleSelectAllLoaded}
                  />
                </th>
                <th><ColumnHead icon={IconStore}>Merchant</ColumnHead></th>
                <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                <th>
                  <ColumnFilter icon={IconUser} label="Onboarding" active={statuses.length > 0}>
                    <FilterOptionList
                      options={ONBOARDING_STATUSES.map((status) => ({ value: status, label: <StatusBadge status={status} /> }))}
                      selected={statuses}
                      onToggle={toggleStatus}
                    />
                  </ColumnFilter>
                </th>
                <th><ColumnHead icon={IconShield}>KYC</ColumnHead></th>
                <th className="dash-num"><ColumnHead icon={IconPercent} align="right">MDR</ColumnHead></th>
                <th><ColumnHead icon={IconLive}>Mode</ColumnHead></th>
                <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
              </tr>
            </thead>
            {loading && merchants.length === 0 ? <SkeletonRows rows={5} columns={8} /> : <tbody>
              {merchants.map((merchant) => (
                <tr key={merchant.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${merchant.displayName}`}
                      checked={selectedIds.has(merchant.id)}
                      onChange={() => toggleSelected(merchant.id)}
                    />
                  </td>
                  <td>
                    <Link to={`/merchants/${merchant.id}`}>{merchant.displayName}</Link>
                    <div className="dash-muted">
                      <code>{merchant.id}</code>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={merchant.status} />
                  </td>
                  <td>
                    <StatusBadge status={merchant.onboardingStatus} />
                  </td>
                  <td>
                    {merchant.kycPassed ? (
                      <Tag tone="pos" icon={IconShield}>KYC passed</Tag>
                    ) : (
                      <Tag tone="warn" icon={IconShield}>KYC pending</Tag>
                    )}
                  </td>
                  <td className="dash-num">{(merchant.mdrBps / 100).toFixed(2)}%</td>
                  <td>
                    {merchant.testMode ? (
                      <Tag tone="neutral" icon={IconDoc}>Test</Tag>
                    ) : (
                      <Tag tone="pos" icon={IconLive}>Live</Tag>
                    )}
                  </td>
                  <td>{formatDate(merchant.createdAt)}</td>
                </tr>
              ))}
              {merchants.length === 0 && !loading ? (
                <tr>
                  <td className="dash-empty-cell" colSpan={8}>
                    <EmptyState icon={IconUser}>No merchants match this search.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>}
          </table>
        </div>

        <div className="dash-pagination"><span>{merchants.length} merchants shown</span>      {nextCursor ? (
          <button className="dash-button dash-button-ghost" type="button" disabled={loading} onClick={() => void load(nextCursor)}>
            Load more
          </button>
        ) : null}</div>
      </div>
    </section>
  );
}
