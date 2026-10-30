import {
  ColumnHead,
  EmptyState,
  IconActivity,
  IconArrowLeft,
  IconBan,
  IconCalendar,
  IconClock,
  IconCoins,
  IconDoc,
  IconKeyRound,
  IconLinks,
  IconLive,
  IconPercent,
  IconSettlement,
  IconShield,
  IconWallet,
  IconWebhooks,
  Money,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tag, formatDate, formatDateTime, formatBusinessDate } from "@filspay/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import { getMerchant, recomputeTransactionStatuses, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { parseAdjustmentBhd } from "../../lib/adjustmentAmount.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { statusLabel } from "../../format.js";
import { describeError, WEB_BASE_URL } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";

import type { AdminMerchantDetail, CreditReasonCode, RotatedApiKey } from "../../types.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

// browser local date not bahrain, fine for bahrain staff, am
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { rememberImpersonation } = useAdminAuth();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kycNotes, setKycNotes] = useState("");
  const [busy, setBusy] = useState(false);

  /** Which key the operator has asked to rotate and not yet confirmed. */
  const [pendingRotation, setPendingRotation] = useState<string | null>(null);
  const [rotationLabel, setRotationLabel] = useState("");
  /** Shown exactly once: `rawKey` exists in the rotate response and nowhere else. */
  const [rotatedKey, setRotatedKey] = useState<RotatedApiKey | null>(null);

  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  const [creditAmountBhd, setCreditAmountBhd] = useState("");
  const [creditAmountError, setCreditAmountError] = useState<string | null>(null);
  const [creditReason, setCreditReason] = useState<CreditReasonCode>("goodwill");
  const [creditMemo, setCreditMemo] = useState("");
  const [creditReverseFee, setCreditReverseFee] = useState(false);
  const [creditEffectiveDate, setCreditEffectiveDate] = useState(todayIso());

  const [adjustDeltaFils, setAdjustDeltaFils] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected"): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await submitKycReview(id, {
        outcome,
        notes: kycNotes.trim() ? kycNotes.trim() : undefined,
      });
      setNotice(
        `KYC ${outcome}. Onboarding is now ${result.onboardingStatus.replace(/_/g, " ")}${
          result.kycPassed ? ", and the merchant has passed KYC." : "."
        }`,
      );
      setKycNotes("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** The old key keeps working for a 24h overlap window, then stops. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // FH: this ends up in adjustMerchantBalanceCache (cache only)
  // MK: it's the journaled one since Sep
  async function handleAdjustBalance(): Promise<void> {
    if (!id) return;
    let deltaFils: number;
    try {
      deltaFils = parseAdjustmentBhd(adjustDeltaFils);
    } catch (err) {
      setActionError(err instanceof RangeError ? "Enter a non-zero amount in BHD, up to 3 decimals." : describeError(err));
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // A fresh Idempotency-Key per submit, the same discipline as the web capture.
      const result = await adjustBalance(id, { deltaFils, reason: adjustReason.trim() }, crypto.randomUUID());
      setNotice(
        `Adjustment of ${bhd(result.deltaFils)} posted to the ledger. It reaches the payable balance at the next settlement close.`,
      );
      setAdjustDeltaFils("");
      setAdjustReason("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueCredit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    // BD in, integer fils out, via the platform's own string-based parser,
    // never parseFloat, which cannot represent the third decimal exactly.
    // Checked before any request so a typo is answered at the field.
    let baseAmountFils: ReturnType<typeof parseBhdToFils>;
    try {
      baseAmountFils = parseBhdToFils(creditAmountBhd.trim());
    } catch {
      setCreditAmountError("Enter an amount in BHD with up to 3 decimals.");
      return;
    }
    if (baseAmountFils <= 0) {
      setCreditAmountError("Enter an amount greater than 0 BHD.");
      return;
    }
    setCreditAmountError(null);
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const record = await issueCredit(id, {
        baseAmountFils,
        reasonCode: creditReason,
        effectiveDate: creditEffectiveDate,
        reverseFee: creditReverseFee,
        memo: creditMemo.trim() ? creditMemo.trim() : undefined,
      }, crypto.randomUUID());
      setNotice(
        record.status === "posted"
          ? `Credit of ${bhd(record.postedAmountFils)} posted to the ledger (entry group ${record.ledgerEntryGroupId ?? "unknown"
          }).`
          : `Credit of ${bhd(record.postedAmountFils)} raised and awaiting a second approver, see Credits.`,
      );
      setCreditAmountBhd("");
      setCreditMemo("");
      setCreditReverseFee(false);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await recomputeTransactionStatuses(id);
      setNotice(
        `Scanned ${result.scanned} transaction${result.scanned === 1 ? "" : "s"}; ` +
        `${result.updated} status${result.updated === 1 ? "" : "es"} updated.`,
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const grant = await startImpersonation(id);
      rememberImpersonation({ ...grant, merchantDisplayName: detail.merchant.displayName });
      // The grant rides an httpOnly cookie set for apps/api's domain, which
      // apps/web already sends with `credentials: 'include'`, so the
      // merchant dashboard just works, unaware of how it was authenticated.
      // Opened in a second tab on purpose: this tab keeps showing the
      // impersonation banner and its exit action, which is the whole point
      // of the banner existing.
      const opened = window.open(WEB_BASE_URL, "_blank", "noopener");
      if (!opened) setImpersonationUrl(WEB_BASE_URL);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="fp-page fp-stagger">
        <PageHeader title="Merchant" />
        <p className="dash-error">{loadError}</p>
        <Link className="dash-button dash-button-ghost" to="/merchants"><IconArrowLeft /> Back to merchants</Link>
      </section>
    );
  }

  if (!detail) {
    return <section className="fp-page fp-stagger"><PageHeader title="Merchant" /><div className="fp-loading" aria-label="Loading" aria-busy="true"><Skeleton height={28} width="45%" /><Skeleton height={72} /><Skeleton height={72} /></div></section>;
  }

  const { merchant } = detail;
  const profile = detail.businessProfile;
  const apiKeys = detail.apiKeys ?? [];
  const webhookEndpoints = detail.webhookEndpoints ?? [];
  const kycReviews = detail.kycReviews ?? [];
  const batches = detail.recentSettlementBatches ?? [];

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title={merchant.displayName} status={<StatusBadge status={merchant.status} />} lede={<code>{merchant.id}</code>} back={<Link to="/merchants"><IconArrowLeft /> Back</Link>} />

      {actionError ? <p className="dash-error">{actionError}</p> : null}
      {notice ? <p className="dash-notice">{notice}</p> : null}

      <div className="dash-card">

        {detail.balance ? (
          <div className="fp-detail-amount"><span>Cached payable</span><Money fils={detail.balance.cachedPayableFils} size="hero" /><p className="fp-widget-description">Updated{" "}
            {formatDateTime(detail.balance.updatedAt)}. The ledger remains authoritative;
            this figure is a cache, rebuildable from Settlement ops.
          </p></div>
        ) : (
          <EmptyState icon={IconCoins}>No cached balance row yet.</EmptyState>
        )}

        <div className="dash-card-head">
          <h2 className="dash-card-title" style={{ margin: 0 }}>Profile</h2>
        </div>
        <dl className="dash-dl">
          <div className="dash-fact"><dt>Status</dt>
            <dd>
              <StatusBadge status={merchant.status} />
            </dd></div>
          <div className="dash-fact"><dt>Onboarding status</dt>
            <dd>
              <StatusBadge status={merchant.onboardingStatus} />
            </dd></div>
          <div className="dash-fact"><dt>KYC</dt>
            <dd>
              {merchant.kycPassed ? (
                <Tag tone="pos" icon={IconShield}>KYC passed</Tag>
              ) : (
                <Tag tone="warn" icon={IconShield}>KYC pending</Tag>
              )}
            </dd></div>
          <div className="dash-fact"><dt>MDR</dt>
            <dd>
              {(merchant.mdrBps / 100).toFixed(2)}% ({merchant.mdrBps} bps)
            </dd></div>
          <div className="dash-fact"><dt>Current negotiated rate</dt>
            <dd>
              {detail.currentFeeSchedule
                ? `${(detail.currentFeeSchedule.mdrBps / 100).toFixed(2)}% (${detail.currentFeeSchedule.mdrBps} bps), effective ${formatDate(detail.currentFeeSchedule.effectiveFrom)}`
                : "no negotiated schedule on file (uses MDR above)"}
            </dd></div>
          <div className="dash-fact"><dt>Mode</dt>
            <dd>
              {merchant.testMode ? (
                <Tag tone="neutral" icon={IconDoc}>Test</Tag>
              ) : (
                <Tag tone="pos" icon={IconLive}>Live</Tag>
              )}
            </dd></div>
          <div className="dash-fact"><dt>Created</dt>
            <dd>{formatDateTime(merchant.createdAt)}</dd></div>
          {profile ? (
            <>
              <div className="dash-fact"><dt>Legal name</dt>
                <dd>{profile.legalName}</dd></div>
              <div className="dash-fact"><dt>Registration number</dt>
                <dd>{profile.registrationNumber}</dd></div>
              <div className="dash-fact"><dt>Business type</dt>
                <dd>{statusLabel(profile.businessType)}</dd></div>
              <div className="dash-fact"><dt>Contact</dt>
                <dd>
                  {profile.contactEmail} / {profile.contactPhone}
                </dd></div>
              <div className="dash-fact"><dt>Address</dt>
                <dd>
                  {profile.addressLine1}
                  {profile.addressLine2 ? `, ${profile.addressLine2}` : ""}, {profile.city}
                  {profile.postalCode ? ` ${profile.postalCode}` : ""}, {profile.country}
                </dd></div>
            </>
          ) : null}
        </dl>
        {!profile ? <EmptyState icon={IconDoc}>No business profile submitted yet.</EmptyState> : null}
      </div>

      <div className="fp-section-grid fp-stagger">
        <section className="dash-card fp-section"><h2>Adjust balance</h2>
          <p className="dash-muted">
            A direct correction to this merchant&apos;s cached payable balance, for when support has
            confirmed the figure on screen is wrong and it needs to be right now rather than after the
            next settlement cycle. Finance operators only.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role is read-only for balance corrections. Ask a finance admin.
              </p>
            }
          >
            <div className="dash-form">
              <label>
                Amount in BHD (negative to take money back)
                <input
                  value={adjustDeltaFils}
                  onChange={(e) => setAdjustDeltaFils(e.target.value)}
                  inputMode="text"
                  placeholder="0.000"
                />
              </label>
              <label>
                Reason
                <input
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="phone confirmation with merchant"
                />
              </label>
              <div className="dash-actions">
                <button
                  className="dash-button dash-button-primary"
                  type="button"
                  disabled={busy || !adjustDeltaFils.trim() || !adjustReason.trim()}
                  onClick={() => void handleAdjustBalance()}
                >
                  Adjust balance
                </button>
              </div>
            </div>
          </RequireRole>

        </section>
        <section className="dash-card fp-section"><h2>Issue credit</h2>
          <p className="dash-muted">
            Journals a manual credit to this merchant&apos;s payable balance. Above the approval limit
            it waits in <Link to="/credits">Credits</Link> for a second finance operator; at or below
            it, it posts immediately. The effective date is the accounting date the ledger legs are
            booked against.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role cannot issue credits. Ask a finance admin.
              </p>
            }
          >
            <form className="dash-form" onSubmit={(e) => void handleIssueCredit(e)}>
              <label>
                Amount (BHD, up to 3 decimals)
                <input
                  type="text"
                  required
                  placeholder="50.000"
                  value={creditAmountBhd}
                  onChange={(e) => setCreditAmountBhd(e.target.value)}
                />
              </label>
              {creditAmountError ? <p className="dash-error">{creditAmountError}</p> : null}
              <label>
                Reason
                <select
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
                >
                  <option value="goodwill">Goodwill</option>
                  <option value="dispute_resolution">Dispute resolution</option>
                  <option value="correction">Correction</option>
                </select>
              </label>
              <label>
                Effective date
                <input
                  type="date"
                  required
                  value={creditEffectiveDate}
                  onChange={(e) => setCreditEffectiveDate(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={creditReverseFee}
                  onChange={(e) => setCreditReverseFee(e.target.checked)}
                />{" "}
                Also reverse the MDR on this amount ({((detail.currentFeeSchedule?.mdrBps ?? merchant.mdrBps) / 100).toFixed(2)}% today, before any negotiated discount)
              </label>
              <label>
                Memo (optional)
                <textarea value={creditMemo} onChange={(e) => setCreditMemo(e.target.value)} rows={2} />
              </label>
              <button className="dash-button dash-button-primary" type="submit" disabled={busy}>
                {busy ? "Submitting..." : "Issue credit"}
              </button>
            </form>
          </RequireRole>

        </section>
        <section className="dash-card fp-section"><h2>KYC review</h2>
          <p className="dash-muted">
            Finance operators approve or reject.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role is read-only for KYC decisions. Ask a finance admin to review.
              </p>
            }
          >
            <div className="dash-form">
              <label>
                Notes (optional)
                <textarea value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} rows={3} />
              </label>
              <div className="dash-actions">
                <button className="dash-button dash-button-primary" type="button" disabled={busy} onClick={() => void handleKycReview("approved")}>
                  Approve KYC
                </button>{" "}
                <button className="dash-button dash-button-danger" type="button" disabled={busy} onClick={() => void handleKycReview("rejected")}>
                  Reject KYC
                </button>
              </div>
            </div>
          </RequireRole>

          <h3>Review history</h3>
          {kycReviews.length === 0 ? <EmptyState icon={IconShield}>No reviews recorded.</EmptyState> : <ol className="fp-timeline">
            {kycReviews.map((review) => <li key={review.id}>
              <div><StatusBadge status={review.outcome} /><div className="fp-timeline-meta">{review.reviewerIdentifier}</div></div>
              <time>{formatDateTime(review.reviewedAt)}</time>
              <div>{review.notes ?? "-"}</div>
            </li>)}
          </ol>}

        </section>
        <section className="dash-card fp-section"><h2>API keys</h2>
          {rotatedKey ? (
            <div className="dash-notice">
              <p>
                <strong>New key issued, copy it now.</strong> This value is shown once and is not
                recoverable afterwards.
              </p>
              <p>
                <code>{rotatedKey.rawKey}</code>
              </p>
              <p className="dash-muted">
                New key id <code>{rotatedKey.id}</code>, replacing previous key{" "}
                <code>{rotatedKey.previousKeyId}</code>.
              </p>
              <button className="dash-button dash-button-ghost" type="button" onClick={() => setRotatedKey(null)}>
                Dismiss
              </button>
            </div>
          ) : null}

          {apiKeys.length === 0 ? (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <tbody>
                  <tr>
                    <td className="dash-empty-cell" colSpan={6}>
                      <EmptyState icon={IconDoc}>No API keys.</EmptyState>
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
                    <th><ColumnHead icon={IconKeyRound}>Prefix</ColumnHead></th>
                    <th><ColumnHead icon={IconDoc}>Label</ColumnHead></th>
                    <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
                    <th><ColumnHead icon={IconClock}>Last Used</ColumnHead></th>
                    <th><ColumnHead icon={IconBan}>Revoked</ColumnHead></th>
                    <th><ColumnHead icon={IconActivity}>Actions</ColumnHead></th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((key) => (
                    <tr key={key.id}>
                      <td>
                        <code>{key.prefix}</code>
                      </td>
                      <td>{key.label ?? "-"}</td>
                      <td>{formatDate(key.createdAt)}</td>
                      <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "never"}</td>
                      <td>{key.revokedAt ? formatDateTime(key.revokedAt) : "-"}</td>
                      <td>
                        {key.revokedAt ? null : (
                          <RequireRole
                            allow={["finance", "super_admin"]}
                            fallback={<span className="dash-muted">finance role required</span>}
                          >
                            <button className="dash-button" type="button" onClick={() => setPendingRotation(key.id)}>
                              Rotate
                            </button>
                          </RequireRole>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pendingRotation ? (
            <div className="dash-confirm dash-form">
              <p>
                <strong>Rotate this API key?</strong> The current key is revoked and a replacement is
                issued in the same transaction, so the merchant is never left without a working key,
                but any integration still sending the old key will start failing immediately.
              </p>
              <label>
                Label for the new key (optional)
                <input
                  type="text"
                  value={rotationLabel}
                  onChange={(e) => setRotationLabel(e.target.value)}
                />
              </label>
              <div className="dash-actions" style={{ margin: 0 }}>
                <button className="dash-button dash-button-primary" type="button" disabled={busy} onClick={() => void handleRotate(pendingRotation)}>
                  {busy ? "Rotating..." : "Yes, rotate it"}
                </button>{" "}
                <button
                  className="dash-button dash-button-ghost"
                  type="button"
                  onClick={() => {
                    setPendingRotation(null);
                    setRotationLabel("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

        </section>
        <section className="dash-card fp-section"><h2>Webhook endpoints</h2>
          {webhookEndpoints.length === 0 ? (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <tbody>
                  <tr>
                    <td className="dash-empty-cell" colSpan={4}>
                      <EmptyState icon={IconWebhooks}>No endpoints registered.</EmptyState>
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
                    <th><ColumnHead icon={IconLinks}>URL</ColumnHead></th>
                    <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                    <th><ColumnHead icon={IconKeyRound}>Secret Prefix</ColumnHead></th>
                    <th><ColumnHead icon={IconCalendar}>Created</ColumnHead></th>
                  </tr>
                </thead>
                <tbody>
                  {webhookEndpoints.map((endpoint) => (
                    <tr key={endpoint.id}>
                      <td>{endpoint.url}</td>
                      <td>
                        <StatusBadge status={endpoint.status} />
                      </td>
                      <td>
                        <code>{endpoint.secretPrefix}</code>
                      </td>
                      <td>{formatDate(endpoint.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            <Link to={`/webhooks/${merchant.id}`}>Replay a batch of deliveries for this merchant</Link>
          </p>

        </section>
        <section className="dash-card fp-section"><h2>Recent settlement batches</h2>
          {batches.length === 0 ? (
            <div className="dash-table-wrap">
              <table className="dash-table">
                <tbody>
                  <tr>
                    <td className="dash-empty-cell" colSpan={5}>
                      <EmptyState icon={IconSettlement}>No batches yet.</EmptyState>
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
                    <th><ColumnHead icon={IconCalendar}>Date</ColumnHead></th>
                    <th><ColumnHead icon={IconClock}>Status</ColumnHead></th>
                    <th className="dash-num"><ColumnHead icon={IconCoins} align="right">Gross</ColumnHead></th>
                    <th className="dash-num"><ColumnHead icon={IconPercent} align="right">Fee</ColumnHead></th>
                    <th className="dash-num"><ColumnHead icon={IconWallet} align="right">Net Payout</ColumnHead></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr key={batch.id}>
                      <td>{formatBusinessDate(batch.batchDate)}</td>
                      <td>
                        <StatusBadge status={batch.status} />
                      </td>
                      <td className="dash-num">
                        <Money fils={batch.grossFils} />
                      </td>
                      <td className="dash-num">
                        <Money fils={batch.feeFils} />
                      </td>
                      <td className="dash-num">
                        <Money fils={batch.netPayoutFils} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        </section>
        <section className="dash-card fp-section"><h2>Recompute transaction statuses</h2>
          <p className="dash-muted">
            Re-derives this merchant&apos;s transaction statuses from their own captured/refunded
            amounts. Rows written before the refunds release can carry a status that predates the
            derivation rule; this backfills them. Rows that already agree are left alone.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="dash-muted">
                Your role cannot run this backfill. Ask a finance admin.
              </p>
            }
          >
            <button className="dash-button" type="button" disabled={busy} onClick={() => void handleRecomputeStatuses()}>
              {busy ? "Working..." : "Recompute statuses"}
            </button>
          </RequireRole>

        </section>
        <section className="dash-card fp-section"><h2>View as merchant</h2>
          <p className="dash-muted">
            Starts a short-lived, audited impersonation grant. It always acts with this merchant&apos;s
            least-privileged <code>support</code> role, never with your admin role, and it expires on
            its own. A banner stays on screen until you exit it.
          </p>
          <button className="dash-button" type="button" disabled={busy} onClick={() => void handleImpersonate()}>
            View as merchant
          </button>
          {impersonationUrl ? (
            <p>
              Your browser blocked the new tab –{" "}
              <a href={impersonationUrl} target="_blank" rel="noreferrer">
                open the merchant dashboard
              </a>
              .
            </p>
          ) : null}
        </section></div>
    </section>
  );
}
