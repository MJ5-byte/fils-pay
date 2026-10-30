import { createBrowserRouter, isRouteErrorResponse, Navigate, Outlet, useRouteError } from "react-router-dom";
import { CrashPage, NotFoundPage } from "@filspay/ui";
import type { RouteObject } from "react-router-dom";
import { CheckoutPage } from "./pages/checkout/CheckoutPage.js";
import { DashboardAuthProvider } from "./auth/DashboardAuthContext.js";
import { RequireDashboardAuth } from "./auth/RequireDashboardAuth.js";
import { RoleGatedPage } from "./auth/RequireRole.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { DashboardLayout } from "./components/DashboardLayout.js";
import { LoginPage } from "./pages/dashboard-login/LoginPage.js";
import { TransactionListPage } from "./pages/transactions/TransactionListPage.js";
import { TransactionDetailPage } from "./pages/transactions/TransactionDetailPage.js";
import { PaymentLinkListPage } from "./pages/payment-links/PaymentLinkListPage.js";
import { PaymentLinkCreatePage } from "./pages/payment-links/PaymentLinkCreatePage.js";
import { PaymentLinkDetailPage } from "./pages/payment-links/PaymentLinkDetailPage.js";
import { WebhookEndpointListPage } from "./pages/webhooks/WebhookEndpointListPage.js";
import { WebhookEndpointCreatePage } from "./pages/webhooks/WebhookEndpointCreatePage.js";
import { WebhookEndpointDetailPage } from "./pages/webhooks/WebhookEndpointDetailPage.js";
import { SettlementBatchListPage } from "./pages/settlement/SettlementBatchListPage.js";
import { SettlementBatchDetailPage } from "./pages/settlement/SettlementBatchDetailPage.js";
import { ReconciliationPage } from "./pages/settlement/ReconciliationPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";

function NotFound() {
  return <NotFoundPage homeHref="/dashboard" homeLabel="Back to dashboard" />;
}

/**
 * The root's error element: a loader or router error (an unknown URL included)
 * gets the designed face, never React Router's default, which prints the raw
 * error. Render errors inside a page are caught first by AppErrorBoundary.
 */
function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return <CrashPage />;
}

// MK: /refunds route removed until FP-212
const routes: RouteObject[] = [
  { path: "/pay/:token", element: <CheckoutPage /> },
  // The root opens the dashboard: an unauthenticated visitor lands on login
  // through the guard below, rather than on a bare router 404. This is also
  // where an admin "view as merchant" grant sends the operator.
  { path: "/", element: <Navigate to="/dashboard" replace /> },

  {
    // The session provider wraps the dashboard subtree only — never
    // /pay/:token above it, which is public, cookie-free, and must keep
    // making exactly zero auth calls. Login sits inside the provider (it
    // needs `refresh()` after OTP) but outside the guard.
    element: (
      <DashboardAuthProvider>
        <Outlet />
      </DashboardAuthProvider>
    ),
    children: [
      { path: "/dashboard/login", element: <LoginPage /> },
      {
        // One shell, one guard for everything below login. The guard is
        // navigation only — the API re-checks the merchant session on every
        // request these pages make.
        element: (
          <RequireDashboardAuth>
            <DashboardLayout />
          </RequireDashboardAuth>
        ),
        children: [
          { path: "/dashboard", element: <Navigate to="/dashboard/overview" replace /> },

          { path: "/dashboard/transactions", element: <TransactionListPage /> },
          { path: "/dashboard/transactions/:id", element: <TransactionDetailPage /> },

          { path: "/dashboard/payment-links", element: <PaymentLinkListPage /> },
          {
            // Create is owner/finance server-side, so a support user is told
            // why rather than shown a form that will 403 on submit.
            path: "/dashboard/payment-links/new",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="New payment link">
                <PaymentLinkCreatePage />
              </RoleGatedPage>
            ),
          },
          { path: "/dashboard/payment-links/:id", element: <PaymentLinkDetailPage /> },

          // Every webhook route — including the plain list read — is
          // owner/finance-only server-side, unlike most list reads
          // in this platform. So the whole section is gated, not just its
          // writes; each page still renders the server's own 403 if one
          // arrives anyway.
          {
            path: "/dashboard/webhooks",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="Webhook endpoints">
                <WebhookEndpointListPage />
              </RoleGatedPage>
            ),
          },
          {
            path: "/dashboard/webhooks/new",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="New webhook endpoint">
                <WebhookEndpointCreatePage />
              </RoleGatedPage>
            ),
          },
          {
            path: "/dashboard/webhooks/:id",
            element: (
              <RoleGatedPage allow={["owner", "finance"]} title="Webhook endpoint">
                <WebhookEndpointDetailPage />
              </RoleGatedPage>
            ),
          },

          { path: "/dashboard/settlement", element: <SettlementBatchListPage /> },
          { path: "/dashboard/settlement/:id", element: <SettlementBatchDetailPage /> },
          { path: "/dashboard/reconciliation", element: <ReconciliationPage /> },

          { path: "/dashboard/overview", element: <OverviewPage /> },
        ],
      },
    ],
  },

  // Outside the session provider, so a mistyped URL answers at once without
  // asking the API who is signed in.
  { path: "*", element: <NotFound /> },
];

// One pathless root so a render error anywhere, /pay/:token included, lands
// on the same short message.
export const router = createBrowserRouter([
  {
    element: (
      <AppErrorBoundary>
        <Outlet />
      </AppErrorBoundary>
    ),
    errorElement: <RouteError />,
    children: routes,
  },
]);
