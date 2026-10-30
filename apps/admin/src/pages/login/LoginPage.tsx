import { CoinLogin, CoinLoginMessage, formatTime } from "@filspay/ui";
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
 * It wears the merchant dashboard's coin login (one design used twice),
 * titled for the console so the two are never mistaken for one another.
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
    <CoinLogin eyebrow="FilsPay" heading={step.kind === "credentials" ? "Admin console" : "Verify it's you"}>
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
          <div className="fp-coin-last">
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
            <CoinLoginMessage error={error} />
          </div>
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
          <div className="fp-coin-last">
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
            <CoinLoginMessage error={error} />
          </div>
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
    </CoinLogin>
  );
}
