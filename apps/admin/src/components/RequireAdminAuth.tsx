import { Navigate, useLocation } from "react-router-dom";
import { useState } from "react";
import type { ReactNode } from "react";
import { useAdminAuth } from "../auth/AdminAuthContext.js";

/**
 * Route guard: renders its children only once `GET /v1/admin/auth/me` has
 * confirmed a live admin session, and sends the operator to `/login`
 * otherwise (remembering where they were headed).
 *
 * This is navigation, not authorization — the console's data is not behind
 * this component, it is behind the API's own `requireAdminSession`
 * preHandler, which answers `401` to an unauthenticated request no matter
 * what this app renders.
 */
/** Redirects to /login while status is anonymous. */
export function RequireAdminAuth({ children }: { children: ReactNode }) {
  const { status, refresh } = useAdminAuth();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);

  if (status === "loading") {
    return (
      <main className="admin-centered">
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
      <main className="admin-centered">
        <p className="admin-error">The server could not be reached, so your session could not be checked.</p>
        <button type="button" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Retrying..." : "Retry"}
        </button>
      </main>
    );
  }

  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
