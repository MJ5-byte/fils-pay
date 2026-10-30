import { useState } from "react";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError } from "../api/client.js";
import { IconAlert, IconLogOut, formatDateTime } from "@filspay/ui";

/**
 * Shown on every admin screen for as long as an impersonation grant is
 * active. Impersonation is a real, privilege-adjacent state, so the
 * one thing this banner must never do is be easy to miss, it sits above
 * the workspace, and it carries its own one-click exit.
 *
 * The exit action calls `POST /v1/admin/impersonation/:grantId/end`, which
 * stamps `ended_at`, writes the closing audit row, and clears the
 * `fp_impersonation` cookie. Note what ending does *not* do: it does not
 * restore any admin privilege, because none was ever given up, `/v1/admin/*`
 * never reads anything impersonation-related. It closes the
 * merchant-read window and completes the audit trail.
 */
// MK: banner wording is accurate, impersonation is view-only
export function ImpersonationBanner() {
  const { impersonation, exitImpersonation } = useAdminAuth();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!impersonation) return null;

  async function handleExit(): Promise<void> {
    setExiting(true);
    setError(null);
    try {
      await exitImpersonation();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExiting(false);
    }
  }

  const label = impersonation.merchantDisplayName ?? impersonation.merchantId;

  return (
    <div className="impersonation-banner" role="alert">
      <span className="impersonation-banner-mark" aria-hidden="true">
        <IconAlert />
      </span>
      <div className="impersonation-banner-body">
        <strong>You are viewing as a merchant.</strong>{" "}
        <span>
          Active grant for <code>{label}</code>, expiring{" "}
          {formatDateTime(impersonation.expiresAt)}. Merchant screens in the dashboard are
          acting with this merchant&apos;s least-privileged (support) role.
        </span>
        {error ? <div className="impersonation-banner-error">Could not end it: {error}</div> : null}
      </div>
      <button
        type="button"
        className="dash-button"
        onClick={() => void handleExit()}
        disabled={exiting}
      >
        <IconLogOut />
        {exiting ? "Exiting..." : "Exit impersonation"}
      </button>
    </div>
  );
}
