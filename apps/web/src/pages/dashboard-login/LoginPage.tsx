import { formatTime } from "@filspay/ui";
import { useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError, describeError } from "../../api/client.js";
import {
  readLastMerchantId,
  useDashboardAuth,
  writeLastMerchantId,
} from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse } from "../../types.js";
import "../../dashboard.css";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: DashboardLoginResponse };

/** Degrees the coin leans with the pointer at its rim: a clear lean, not a flip. */
const TILT_MAX_DEG = 9;
/** The coin's radius as a share of its image's half width (the rest is shadow). */
const COIN_RADIUS = 0.918;
/** Past the rim the lean fades out over this many more coin radii, never a jump. */
const TILT_FADE = 0.6;
/** Where the render's key light sits on the face (top left), in percent of the disc. */
const GLARE_HOME = { x: 28, y: 24 };
/** How far the highlight slides with the lean, in percent of the disc. */
const GLARE_TRAVEL = 18;

/**
 * Two-step merchant login: merchantId + email + password
 * creates a *pending* session and issues an OTP challenge; the OTP step is
 * what actually authenticates it. Neither step is told which credential was
 * wrong: the API answers a single generic `invalid_credentials`, and this
 * screen shows one generic sentence for it rather than guessing at something more specific.
 *
 * The Merchant ID field is a raw pasted UUID. This is a genuine rough edge,
 * not a preference: `merchant_users.email` is unique per merchant rather than
 * globally (Phase 1 schema), so an email alone cannot identify a user, and no
 * merchant slug or subdomain concept exists anywhere in the platform to infer
 * the id from. `localStorage` remembering the last-used value is the whole
 * mitigation available without new backend work; a lookup-by-email endpoint
 * or a per-merchant subdomain would be the real fix, and both are out of
 * scope for a frontend-only phase.
 */
export function LoginPage() {
  const { status, refresh } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  // MK: remembers the last merchantId in localStorage. not a secret
  const [merchantId, setMerchantId] = useState(() => readLastMerchantId());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const discRef = useRef<HTMLDivElement>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/dashboard/transactions";

  // Mouse only: a touch has no hover, and reduced motion keeps the coin flat
  // (the CSS also drops the transform there).
  function tiltToward(event: React.PointerEvent): void {
    const disc = discRef.current;
    if (!disc || event.pointerType !== "mouse") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = disc.getBoundingClientRect();
    const half = box.width / 2;
    const radius = half * COIN_RADIUS;
    let dx = (event.clientX - (box.left + half)) / radius;
    let dy = (event.clientY - (box.top + half)) / radius;
    const reach = Math.hypot(dx, dy);
    if (reach >= 1 + TILT_FADE) {
      settle();
      return;
    }
    if (reach > 1) {
      const fade = (1 + TILT_FADE - reach) / TILT_FADE;
      dx = (dx / reach) * fade;
      dy = (dy / reach) * fade;
    }
    // The face turns toward the pointer. Turning it toward the key light (top
    // left) brightens the highlight there; turning it away dims it, so the
    // sheen always agrees with the light baked into the render.
    const facingKey = Math.max(0, -(dx + dy) / Math.SQRT2);
    disc.dataset.tilting = "";
    disc.style.setProperty("--fp-tilt-x", `${(-dy * TILT_MAX_DEG).toFixed(2)}deg`);
    disc.style.setProperty("--fp-tilt-y", `${(dx * TILT_MAX_DEG).toFixed(2)}deg`);
    disc.style.setProperty("--fp-glare-x", `${(GLARE_HOME.x + dx * GLARE_TRAVEL).toFixed(1)}%`);
    disc.style.setProperty("--fp-glare-y", `${(GLARE_HOME.y + dy * GLARE_TRAVEL).toFixed(1)}%`);
    disc.style.setProperty("--fp-glare-o", (0.45 + 0.55 * facingKey).toFixed(2));
    disc.style.setProperty("--fp-shade-o", Math.min(1, Math.hypot(dx, dy)).toFixed(2));
  }

  function settle(): void {
    const disc = discRef.current;
    if (!disc) return;
    delete disc.dataset.tilting;
    for (const name of ["--fp-tilt-x", "--fp-tilt-y", "--fp-glare-x", "--fp-glare-y", "--fp-glare-o", "--fp-shade-o"]) {
      disc.style.removeProperty(name);
    }
  }

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setCode("");
    setError(message);
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await login({ merchantId: merchantId.trim(), email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? (am)
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      writeLastMerchantId(merchantId.trim());
      // The session cookie is now authenticated server-side; re-read `me` so
      // the rest of the dashboard renders from the server's answer, not from
      // the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // `429 too_many_attempts` revokes the pending session server-side, so
      // retrying the OTP step against it can only ever fail again, start
      // over instead of leaving the user tapping a dead form.
      if (err instanceof ApiError && err.statusCode === 429 && err.code === "too_many_attempts") {
        backToCredentials(describeError(err));
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await resendOtp();
      setStep({ kind: "otp", challenge });
      setCode("");
      setNotice("A new code has been sent.");
    } catch (err) {
      // Includes `429 resend_too_soon`: the server owns the cadence rule, so
      // whatever it says is shown as-is rather than pre-empted by a
      // client-side timer that could drift from it.
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // The page is a real Bahrain 100 fils coin; the form sits on its silver
    // disc, and the eyebrow carries the product name the coin does not.
    <main className="fp-coin-login" onPointerMove={tiltToward} onPointerLeave={settle}>
      <div className="fp-coin-disc" ref={discRef}>
        <div className="fp-coin-field">
          <header className="fp-coin-title">
            <p className="fp-eyebrow">FilsPay merchants</p>
            <h1 className="fp-auth-heading">{step.kind === "credentials" ? "Sign in" : "Verify it's you"}</h1>
          </header>

          {step.kind === "credentials" ? (
            <form onSubmit={(e) => void handleCredentials(e)} className="dash-form">
              <label>
                Merchant ID
                <input
                  type="text"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your merchant ID"
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <p className={error ? "fp-coin-message fp-coin-message-error" : "fp-coin-message"} role="status">
                {error ?? notice}
              </p>
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Signing in" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
              <p>
                Code sent to <strong>{email}</strong>, valid until {formatTime(step.challenge.otpExpiresAt)}.
              </p>
              {step.challenge.devOtpCode ? (
                <p className="dash-muted">
                  Development code: <code>{step.challenge.devOtpCode}</code>
                </p>
              ) : null}
              <label>
                One-time code
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <p className={error ? "fp-coin-message fp-coin-message-error" : "fp-coin-message"} role="status">
                {error ?? notice}
              </p>
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Verifying" : "Verify"}
              </button>
              <div className="dash-actions" style={{ margin: 0 }}>
                <button
                  type="button"
                  className="dash-button-ghost"
                  disabled={submitting}
                  onClick={() => void handleResend()}
                >
                  Resend code
                </button>
                <button
                  type="button"
                  className="dash-button-ghost"
                  onClick={() => backToCredentials(null)}
                >
                  Start over
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
