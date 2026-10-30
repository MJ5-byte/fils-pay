import { formatTime } from "@filspay/ui";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, verifyOtp } from "../../api/auth.js";
import { describeError } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";

import type { AdminLoginResponse } from "../../types.js";
import "../../admin.css";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: AdminLoginResponse };

/**
 * Two-step admin login: email + password creates a *pending* session
 * and issues an OTP challenge; the OTP step is what actually authenticates
 * it. Neither step is told which half of a bad credential pair was wrong.
 * The API answers a single generic `invalid_credentials`, and this screen
 * shows one generic sentence for it rather than guessing at something more specific.
 *
 * It wears the same split-face auth screen as the merchant dashboard (the one
 * shared design system), marked as the staff console so the two are never
 * mistaken for one another.
 */
export function LoginPage() {
  const { status, refresh } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/overview";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await login({ email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // YA: admin verify re-issues the cookie with the full TTL
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await verifyOtp({ code });
      // The session cookie is now authenticated server-side; re-read `me`
      // so the rest of the console renders from the server's answer, not
      // from the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dash-auth">
      <main className="dash-auth-form">
        <div className="dash-auth-form-inner">
          <div className="dash-auth-logo"><span className="dash-wordmark">FILSPAY</span></div>
          <p className="fp-eyebrow">Admin console</p>
          <h1 className="fp-auth-heading">{step.kind === "credentials" ? "Sign in" : "Verify it's you"}</h1>
          <p className="dash-lede" style={{ marginBottom: "var(--fp-5)" }}>
            {step.kind === "credentials"
              ? "Internal operations console."
              : "Enter the one-time code to finish signing in."}
          </p>

          {error ? <p className="dash-error">{error}</p> : null}

          {step.kind === "credentials" ? (
            <form onSubmit={(e) => void handleCredentials(e)} className="dash-form">
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
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Signing in" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
              <p>
                A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
                {formatTime(step.challenge.otpExpiresAt)}.
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
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                {submitting ? "Verifying" : "Verify"}
              </button>
              <div className="dash-actions" style={{ margin: 0 }}>
                <button
                  type="button"
                  className="dash-button-ghost"
                  onClick={() => {
                    setStep({ kind: "credentials" });
                    setCode("");
                    setError(null);
                  }}
                >
                  Start over
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
      <aside className="fp-auth-material" role="img" aria-label="Macro photograph of coin edges" />
    </div>
  );
}
