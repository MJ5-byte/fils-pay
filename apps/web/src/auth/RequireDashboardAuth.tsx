import { Navigate, useLocation } from "react-router-dom";
import { useState } from "react";
import type { ReactNode } from "react";
import { useDashboardAuth } from "./DashboardAuthContext.js";

/**
 * Route guard: renders its children only once `GET /v1/auth/me` has
 * confirmed a live merchant session, and sends the user to
 * `/dashboard/login` otherwise (remembering where they were headed).
 *
 * This is navigation, not authorization — the dashboard's data is not behind
 * this component, it is behind the API's own `requireMerchantAuth`
 * preHandler, which answers `401` to an unauthenticated request no matter
 * what this app renders.
 */
// FH: redirect loop on expired session -> fixed by #402
export function RequireDashboardAuth({ children }: { children: ReactNode }) {
  const { status, refresh } = useDashboardAuth();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);

  if (status === "loading") {
    return (
      <main className="dash-centered">
        <p>Checking your session...</p>
      </main>
    );
  }

  if (status === "unavailable") {
    const retry = async (): Promise<void> => {
      setRetrying(true);
      try {
        await refresh();
      } finally {
        setRetrying(false);
      }
    };
    return (
      <main className="dash-centered">
        <p className="dash-error">The server could not be reached, so your session could not be checked.</p>
        <button type="button" className="dash-button" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Retrying..." : "Retry"}
        </button>
      </main>
    );
  }

  if (status === "anonymous") {
    return (
      <Navigate
        to="/dashboard/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return <>{children}</>;
}
