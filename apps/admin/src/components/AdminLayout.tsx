import {
  PageHeaderSection,
  IconExternal,
  IconFileUp,
  IconHandCoins,
  IconLogout,
  IconMenu,
  IconOverview,
  IconSettlement,
  IconShield,
  IconStore,
  IconWebhooks,
  IconX,
  Tag,
  Tooltip,
  useNavigationDrawer,
} from "@filspay/ui";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

import "../admin.css";

const navItems = {
  "overview": { to: "/overview", group: null },
  "merchants": { to: "/merchants", group: "Operations" },
  "credits": { to: "/credits", group: "Operations" },
  "settlement": { to: "/settlement", group: "Operations" },
  "adjustment-imports": { to: "/adjustment-imports", group: "Operations" },
  "webhooks": { to: "/webhooks", group: "Operations" },
} as const;

/** Nav shell for every admin-plane screen. It is the merchant dashboard's
 *  shell wearing the same design system (the one law of this house: both
 *  consoles read as one product), with two things the merchant plane has no
 *  need of: an identity marked as staff, and the impersonation banner that
 *  rides above everything whenever a view-as-merchant grant is live. */
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const { pathname } = useLocation();
  const pageSection = Object.values(navItems).find(({ to }) =>
    pathname === to || pathname.startsWith(`${to}/`),
  )?.group ?? "Admin console";
  const { menuOpen, setMenuOpen, sheetRef, menuRef, mainRef } = useNavigationDrawer(pathname);
  const pageTitle = (pathname.split("/")[1] || "Overview").replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="admin-frame">
      <div className="dash-shell">
        <aside className="dash-sidebar">
          <div className="dash-sidebar-inner">
            <div className="dash-brand">
              <span className="dash-wordmark">FILSPAY</span>
              <span className="fp-console-name">Admin</span>
            </div>
            <button ref={menuRef} type="button" className="fp-menu-button" aria-label="Menu" aria-expanded={menuOpen} aria-controls="admin-rail-menu" onClick={() => setMenuOpen(!menuOpen)}>
              {menuOpen ? <IconX /> : <IconMenu />}
            </button>
            <span className="fp-mobile-title">FILSPAY<span className="fp-sr-only">, {pageTitle}</span></span>
            <span className="fp-avatar" aria-label={admin?.email ?? "Account"}>{admin?.email.slice(0, 2).toUpperCase() ?? "?"}</span>
            <button className="fp-nav-backdrop" data-open={menuOpen} tabIndex={-1} aria-hidden="true" onClick={() => { setMenuOpen(false); menuRef.current?.focus(); }} />
            <div ref={sheetRef} id="admin-rail-menu" className="fp-rail-content" data-open={menuOpen}>
              <div className="dash-brand fp-drawer-brand"><span className="dash-wordmark">FILSPAY</span><span className="fp-console-name">Admin</span></div>
              <nav className="dash-nav" aria-label="Main navigation" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) { setMenuOpen(false); if (window.matchMedia("(max-width: 1023px)").matches) menuRef.current?.focus(); } }}>
                {/* Overview is pinned at the top of the nav, the one surface that
                  reads the operator's queues at a glance. */}
                <NavLink to={navItems["overview"].to}>
                  <IconOverview />
                  <span className="fp-nav-label">Overview</span>
                </NavLink>
                <span className="fp-nav-group">{navItems["merchants"].group}</span>
                <NavLink to={navItems["merchants"].to}>
                  <IconStore />
                  <span className="fp-nav-label">Merchants</span>
                </NavLink>
                <NavLink to={navItems["credits"].to}>
                  <IconHandCoins />
                  <span className="fp-nav-label">Credits</span>
                </NavLink>
                <NavLink to={navItems["settlement"].to}>
                  <IconSettlement />
                  <span className="fp-nav-label">Settlement ops</span>
                </NavLink>
                <NavLink to={navItems["adjustment-imports"].to}>
                  <IconFileUp />
                  <span className="fp-nav-label">Adjustments</span>
                </NavLink>
                <NavLink to={navItems["webhooks"].to}>
                  <IconWebhooks />
                  <span className="fp-nav-label">Webhook replay</span>
                </NavLink>
              </nav>

              <div className="dash-identity">
                {admin ? <>
                  <span className="fp-identity-avatar" aria-hidden="true">{admin.email.slice(0, 2).toUpperCase()}</span>
                  <div className="dash-identity-who">
                    <span className="dash-identity-name">{admin.email.split("@")[0]}</span>
                    <Tooltip label={admin.email}><span className="dash-identity-email" tabIndex={0}>{admin.email}</span></Tooltip>
                    <Tag icon={IconShield}>{admin.role.replace(/_/g, " ")}</Tag>
                  </div>
                </> : null}
                <Tooltip label="Log out"><button type="button" aria-label="Log out" className="dash-button-ghost fp-icon-button" onClick={() => void handleSignOut()}><IconLogout /></button></Tooltip>
              </div>
            </div>
          </div>
        </aside>

        <main ref={mainRef} className="dash-main">
          <ImpersonationBanner />
          <PageHeaderSection.Provider value={pageSection}>
            <div className="fp-route" key={pathname}>
              {error ? <p className="dash-error">{error}</p> : null}

              {impersonation ? (
                // An explicit "exit view-as-merchant" action is required before
                // admin-plane screens are shown again. This is a UX safeguard so
                // the two modes are never confused on screen; the privilege
                // boundary itself does not depend on it. /v1/admin/* never reads
                // the impersonation cookie, and the merchant side never reads the
                // admin session cookie.
                <section className="dash-card admin-paused">
                  <h1>Admin screens are paused</h1>
                  <p className="dash-lede">
                    An impersonation grant is active. Use <strong>Exit impersonation</strong> above to
                    end it and return to the admin console.
                  </p>
                  <a className="dash-button dash-button-ghost" href={`${WEB_BASE_URL}/dashboard`}>
                    <IconExternal />
                    Merchant screens are at {WEB_BASE_URL}
                  </a>
                </section>
              ) : (
                <Outlet />
              )}
            </div>
          </PageHeaderSection.Provider>
        </main>
      </div>
    </div>
  );
}
