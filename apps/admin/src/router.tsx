import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { AdminLayout } from "./components/AdminLayout.js";
import { RequireAdminAuth } from "./components/RequireAdminAuth.js";
import { AdjustmentImportPage } from "./pages/adjustments/AdjustmentImportPage.js";
import { CreditsPage } from "./pages/credits/CreditsPage.js";
import { LoginPage } from "./pages/login/LoginPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";
import { MerchantListPage } from "./pages/merchants/MerchantListPage.js";
import { MerchantDetailPage } from "./pages/merchants/MerchantDetailPage.js";
import { SettlementPage } from "./pages/settlement/SettlementPage.js";
import { WebhookReplayPage } from "./pages/webhooks/WebhookReplayPage.js";

// MK: /v2 routes live behind VITE_ADMIN_V2 — see the admin v2 doc
const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    // Everything below the login screen shares one shell and one guard. The
    // guard is navigation only — the API re-checks the admin session on
    // every request these pages make.
    element: (
      <RequireAdminAuth>
        <AdminLayout />
      </RequireAdminAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/overview" replace /> },
      { path: "/overview", element: <OverviewPage /> },
      { path: "/merchants", element: <MerchantListPage /> },
      { path: "/merchants/:id", element: <MerchantDetailPage /> },
      { path: "/credits", element: <CreditsPage /> },
      { path: "/settlement", element: <SettlementPage /> },
      { path: "/adjustment-imports", element: <AdjustmentImportPage /> },
      { path: "/webhooks", element: <WebhookReplayPage /> },
      { path: "/webhooks/:merchantId", element: <WebhookReplayPage /> },
    ],
  },
];

// One pathless root so a render error on any page lands on the same short
// message.
export const router = createBrowserRouter([
  {
    element: (
      <AppErrorBoundary>
        <Outlet />
      </AppErrorBoundary>
    ),
    children: routes,
  },
]);
