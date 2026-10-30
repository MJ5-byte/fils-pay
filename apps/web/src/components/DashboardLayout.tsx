import {
  PageHeaderSection,
  Tooltip,
  useNavigationDrawer,
} from "@filspay/ui";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import {
  IconLinks,
  IconLogout,
  IconMenu,
  IconX,
  Tag,
  IconOverview,
  IconReconciliation,
  IconSettlement,
  IconTransactions,
  IconUser,
  IconWebhooks,
} from "./icons.js";
import "../dashboard.css";

const navItems = {
  "overview": { to: "/dashboard/overview", group: null },
  "transactions": { to: "/dashboard/transactions", group: "Payments" },
  "payment-links": { to: "/dashboard/payment-links", group: "Payments" },
  "webhooks": { to: "/dashboard/webhooks", group: "Payments" },
  "settlement": { to: "/dashboard/settlement", group: "Payments" },
  "reconciliation": { to: "/dashboard/reconciliation", group: "Payments" },
} as const;

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here, nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const { pathname } = useLocation();
  const pageSection = Object.values(navItems).find(({ to }) =>
    pathname === to || pathname.startsWith(`${to}/`),
  )?.group ?? "Merchant dashboard";
  const { menuOpen, setMenuOpen, sheetRef, menuRef, mainRef } = useNavigationDrawer(pathname);
  const pageTitle = (pathname.split("/")[2] || "Overview").replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

  // sign out clears the cookie server side, local merchantId stays (am)
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <aside className="dash-sidebar">
        <div className="dash-sidebar-inner">
          <div className="dash-brand">
            <span className="dash-wordmark">FILSPAY</span>
            <span className="fp-console-name">Merchant</span>
          </div>
          <button ref={menuRef} type="button" className="fp-menu-button" aria-label="Menu" aria-expanded={menuOpen} aria-controls="web-rail-menu" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <IconX /> : <IconMenu />}
          </button>
          <span className="fp-mobile-title">FILSPAY<span className="fp-sr-only">, {pageTitle}</span></span>
          <span className="fp-avatar" aria-label={me?.email ?? "Account"}>{me?.email.slice(0, 2).toUpperCase() ?? "?"}</span>
          <button className="fp-nav-backdrop" data-open={menuOpen} tabIndex={-1} aria-hidden="true" onClick={() => { setMenuOpen(false); menuRef.current?.focus(); }} />
          <div ref={sheetRef} id="web-rail-menu" className="fp-rail-content" data-open={menuOpen}>
            <div className="dash-brand fp-drawer-brand"><span className="dash-wordmark">FILSPAY</span><span className="fp-console-name">Merchant</span></div>
            <nav className="dash-nav" aria-label="Main navigation" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) { setMenuOpen(false); if (window.matchMedia("(max-width: 1023px)").matches) menuRef.current?.focus(); } }}>
              {/* Overview is pinned at the top of the nav: it is the one surface
                that reads the whole account at a glance. */}
              <NavLink to={navItems["overview"].to}>
                <IconOverview />
                <span className="fp-nav-label">Overview</span>
              </NavLink>
              <span className="fp-nav-group">{navItems["transactions"].group}</span>
              <NavLink to={navItems["transactions"].to}>
                <IconTransactions />
                <span className="fp-nav-label">Transactions</span>
              </NavLink>
              <NavLink to={navItems["payment-links"].to}>
                <IconLinks />
                <span className="fp-nav-label">Payment links</span>
              </NavLink>
              {/* Every webhook route, including the plain list read, is
                owner/finance-only server-side, so the link itself is
                hidden from support rather than offered and then refused. */}
              <RequireRole allow={["owner", "finance"]}>
                <NavLink to={navItems["webhooks"].to}>
                  <IconWebhooks />
                  <span className="fp-nav-label">Webhooks</span>
                </NavLink>
              </RequireRole>
              <NavLink to={navItems["settlement"].to}>
                <IconSettlement />
                <span className="fp-nav-label">Settlement</span>
              </NavLink>
              <RequireRole allow={["owner", "finance"]}>
                <NavLink to={navItems["reconciliation"].to}>
                  <IconReconciliation />
                  <span className="fp-nav-label">Reconciliation</span>
                </NavLink>
              </RequireRole>
            </nav>

            <div className="dash-identity">
              {me ? <>
                <span className="fp-identity-avatar" aria-hidden="true">{me.email.slice(0, 2).toUpperCase()}</span>
                <div className="dash-identity-who">
                  <span className="dash-identity-name">{me.merchant.displayName}</span>
                  <Tooltip label={me.email}><span className="dash-identity-email" tabIndex={0}>{me.email}</span></Tooltip>
                  <Tag icon={IconUser}>{me.role.replace(/_/g, " ")}</Tag>
                </div>
              </> : null}
              <Tooltip label="Log out"><button type="button" aria-label="Log out" className="dash-button-ghost fp-icon-button" onClick={() => void handleSignOut()}><IconLogout /></button></Tooltip>
            </div>
          </div>
        </div>
      </aside>

      <main ref={mainRef} className="dash-main">
        <PageHeaderSection.Provider value={pageSection}>
          <div className="fp-route" key={pathname}>
            {error ? <p className="dash-error">{error}</p> : null}
            <Outlet />
          </div>
        </PageHeaderSection.Provider>
      </main>
    </div>
  );
}
