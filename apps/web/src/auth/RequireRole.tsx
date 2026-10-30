import type { ReactNode } from "react";
import { useDashboardAuth } from "./DashboardAuthContext.js";
import type { MerchantRole } from "../types.js";

/**
 * A UI-only convenience gate. It is **explicitly not** the security boundary
 * for anything it wraps.
 *
 * What this hides is also gated server-side by the route's own
 * `requireMerchantRole(...)` — payment-link create/cancel, every webhook
 * route, the reconciliation report, transaction capture and void.
 *
 * Hence the deliberate default: when the current role is unknown (the `me`
 * call hasn't resolved), `children` are shown, not hidden. Hiding on
 * uncertainty would quietly turn this into the thing deciding access. The
 * server's `403` is the answer; `describeError` renders it plainly when it
 * comes back.
 */
// MK: UI gate only. the server enforces roles
export function RequireRole({
  allow,
  children,
  fallback = null,
}: {
  allow: MerchantRole[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { me } = useDashboardAuth();
  if (me && !allow.includes(me.role)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}

/**
 * The page-level form of the same gate, for the three routes whose server
 * side is role-gated end to end (payment-link create, both webhook write
 * pages). It exists only so a `support` user who typed or bookmarked the URL
 * gets a sentence instead of a blank page — `RequireRole`'s `null` fallback
 * is right for hiding a button and wrong for hiding a whole screen.
 *
 * Still not the boundary: the server answers `403` to the request regardless
 * of what renders here.
 */
/** UI-only: hides the page, does not protect the endpoint behind it. */
export function RoleGatedPage({
  allow,
  title,
  children,
}: {
  allow: MerchantRole[];
  title: string;
  children: ReactNode;
}) {
  return (
    <RequireRole
      allow={allow}
      fallback={
        <section>
          <h1>{title}</h1>
          <p className="dash-error">
            You don&apos;t have permission to use this page — ask an owner or finance
            user on your account.
          </p>
        </section>
      }
    >
      {children}
    </RequireRole>
  );
}
