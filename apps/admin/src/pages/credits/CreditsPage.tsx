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
 * isn't shown a control that would answer 403 — the gate itself lives on the
 * route, server-side.
 */
// approve is gated server side but issuing (MerchantDetail) only in the ui? — am
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

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const page = await listCreditRequests({ status });
      setItems(page.items ?? []);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
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
        `Approved. ${bhd(record.postedAmountFils)} journaled to entry group ${
          record.ledgerEntryGroupId ?? "(unknown)"
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
    <section>
      <h1>Merchant credits</h1>
      <p className="admin-muted">
        Manual credits are journaled to <code>ledger_entries</code> like any other money movement.
        A credit above the approval limit cannot post until a second <code>finance</code> or{" "}
        <code>super_admin</code> operator — not the one who raised it — approves it.
      </p>

      <nav className="admin-nav">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            disabled={tab.value === status}
            onClick={() => setStatus(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {loadError ? <p className="admin-error">{loadError}</p> : null}
      {actionError ? <p className="admin-error">{actionError}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      {items.length === 0 ? (
        <p className="admin-muted">Nothing here.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Requested by</th>
              <th>Merchant</th>
              <th>Reason</th>
              <th>Base</th>
              <th>Fee reversal</th>
              <th>Posted total</th>
              <th>Effective date</th>
              <th>Approved by</th>
              <th />
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
                  {item.reasonCode}
                  {item.memo ? <div className="admin-muted">{item.memo}</div> : null}
                </td>
                <td>{bhd(item.baseAmountFils)}</td>
                <td>{item.feeReversalFils > 0 ? bhd(item.feeReversalFils) : "-"}</td>
                <td>
                  <strong>{bhd(item.postedAmountFils)}</strong>
                </td>
                <td>{item.effectiveDate}</td>
                <td>{item.approvedByDisplayName ?? "-"}</td>
                <td>
                  {item.status === "pending_approval" ? (
                    <RequireRole
                      allow={["finance", "super_admin"]}
                      fallback={<span className="admin-muted">finance role required</span>}
                    >
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void handleApprove(item.id)}
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => setPendingReject(item.id)}
                      >
                        Reject
                      </button>
                    </RequireRole>
                  ) : (
                    item.status
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingReject ? (
        <div className="admin-confirm">
          <p>
            <strong>Reject this credit request?</strong> Nothing is journaled, and the request
            cannot be approved afterwards.
          </p>
          <label>
            Reason (optional — recorded in the admin audit log)
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busyId === pendingReject}
            onClick={() => void handleReject(pendingReject)}
          >
            Yes, reject it
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setPendingReject(null);
              setRejectReason("");
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {nextCursor ? (
        <p>
          <button type="button" onClick={() => void loadMore()}>
            Load more
          </button>
        </p>
      ) : null}
    </section>
  );
}
