import {
  ColumnHead,
  EmptyState,
  IconActivity,
  IconCalendar,
  IconCoins,
  IconDoc,
  IconReturn,
  IconStore,
  IconUser,
  Money,
  PageHeader,
  SkeletonRows,
  StatusBadge,
  formatBusinessDate,
} from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import {
  approveCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "../../api/credits.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";

import type { CreditRequestDto, CreditRequestStatus } from "../../types.js";
import { statusLabel } from "../../format.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const STATUS_TABS: Array<{ value: CreditRequestStatus; label: string }> = [
  { value: "pending_approval", label: "Awaiting approval" },
  { value: "posted", label: "Posted" },
  { value: "rejected", label: "Rejected" },
];

/**
 * The checker half of maker-checker: every credit waiting on a second
 * operator, plus the history of what was posted or declined.
 *
 * Approve and Reject are wrapped in `RequireRole` so a support operator
 * isn't shown a control that would answer 403, the gate itself lives on the
 * route, server-side.
 */
// approve is gated server side but issuing (MerchantDetail) only in the ui?, am
// MK: both are server-side
export function CreditsPage() {
  const [status, setStatus] = useState<CreditRequestStatus>("pending_approval");
  const [items, setItems] = useState<CreditRequestDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [pendingReject, setPendingReject] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listCreditRequests({ status });
      setItems(page.items ?? []);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    try {
      const page = await listCreditRequests({ status, cursor: nextCursor });
      setItems((current) => [...current, ...(page.items ?? [])]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }

  async function handleApprove(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      const record = await approveCreditRequest(id);
      setNotice(
        `Approved. ${bhd(record.postedAmountFils)} journaled to entry group ${record.ledgerEntryGroupId ?? "(unknown)"
        }.`,
      );
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.code === "self_approval_forbidden"
          ? "You can't approve a credit you requested. Ask another admin to approve it."
          : describeError(err),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await rejectCreditRequest(id, rejectReason.trim() ? rejectReason.trim() : undefined);
      setNotice("Credit request rejected. Nothing was journaled.");
      setPendingReject(null);
      setRejectReason("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="Merchant credits" lede="Credits above the approval limit wait for a second finance operator." />

      <div className="fp-list-card">
        <div className="dash-toolbar">
          <nav className="dash-chips">
            {STATUS_TABS.map((tab) => (
              <button
                className={`dash-button dash-chip${tab.value === status ? " dash-chip-on" : ""}`}
                key={tab.value}
                type="button"
                disabled={tab.value === status}
                onClick={() => setStatus(tab.value)}
              >
                <StatusBadge status={tab.value}>{tab.label}</StatusBadge>
              </button>
            ))}
          </nav>
        </div>

        {loadError ? <p className="dash-error">{loadError}</p> : null}
        {actionError ? <p className="dash-error">{actionError}</p> : null}
        {notice ? <p className="dash-notice">{notice}</p> : null}

        {loading ? <div className="dash-table-wrap"><table className="dash-table"><SkeletonRows rows={5} columns={9} /></table></div> : items.length === 0 ? (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <tbody>
                <tr>
                  <td className="dash-empty-cell" colSpan={9}>
                    <EmptyState icon={IconCoins}>Nothing here.</EmptyState>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th><ColumnHead icon={IconUser}>Requested By</ColumnHead></th>
                  <th><ColumnHead icon={IconStore}>Merchant</ColumnHead></th>
                  <th><ColumnHead icon={IconDoc}>Reason</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Base</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconReturn} align="right">Fee Reversal</ColumnHead></th>
                  <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Posted Total</ColumnHead></th>
                  <th><ColumnHead icon={IconCalendar}>Effective Date</ColumnHead></th>
                  <th><ColumnHead icon={IconUser}>Approved By</ColumnHead></th>
                  <th><ColumnHead icon={IconActivity}>Actions</ColumnHead></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.requestedByDisplayName}</td>
                    <td>
                      <Link to={`/merchants/${item.merchantId}`}>
                        <code>{item.merchantId.slice(0, 8)}</code>
                      </Link>
                    </td>
                    <td>
                      {statusLabel(item.reasonCode)}
                      {item.memo ? <div className="dash-muted">{item.memo}</div> : null}
                    </td>
                    <td className="dash-num">
                      <Money fils={item.baseAmountFils} />
                    </td>
                    <td className="dash-num">{item.feeReversalFils > 0 ? <Money fils={item.feeReversalFils} /> : "-"}</td>
                    <td className="dash-num">
                      <strong><Money fils={item.postedAmountFils} /></strong>
                    </td>
                    <td>{formatBusinessDate(item.effectiveDate)}</td>
                    <td>{item.approvedByDisplayName ?? "-"}</td>
                    <td>
                      {item.status === "pending_approval" ? (
                        <RequireRole
                          allow={["finance", "super_admin"]}
                          fallback={<span className="dash-muted">finance role required</span>}
                        >
                          <button
                            className="dash-button dash-button-primary"
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void handleApprove(item.id)}
                          >
                            Approve
                          </button>{" "}
                          <button
                            className="dash-button dash-button-danger"
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => setPendingReject(item.id)}
                          >
                            Reject
                          </button>
                        </RequireRole>
                      ) : (
                        <StatusBadge status={item.status} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="dash-pagination"><span>{items.length} requests shown</span>      {nextCursor ? (
          <p>
            <button className="dash-button dash-button-ghost" type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          </p>
        ) : null}</div>
      </div>
      {pendingReject ? (
        <div className="dash-confirm dash-form">
          <p>
            <strong>Reject this credit request?</strong> Nothing is journaled, and the request
            cannot be approved afterwards.
          </p>
          <label>
            Reason (optional, recorded in the admin audit log)
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
          <div className="dash-actions" style={{ margin: 0 }}>
            <button
              className="dash-button dash-button-danger"
              type="button"
              disabled={busyId === pendingReject}
              onClick={() => void handleReject(pendingReject)}
            >
              Yes, reject it
            </button>{" "}
            <button
              className="dash-button dash-button-ghost"
              type="button"
              onClick={() => {
                setPendingReject(null);
                setRejectReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

    </section>
  );
}
