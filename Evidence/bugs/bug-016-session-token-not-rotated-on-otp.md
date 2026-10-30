# BUG-016 — Session Token Not Rotated on OTP Promotion and Cookie Expiry Not Extended

## 1. Summary

Session promotion upon successful OTP verification flips authenticated flag without rotating the session bearer token (session fixation), while simultaneously failing to send a replacement Set-Cookie header with the extended 12-hour TTL, causing browser cookies to expire after 10 minutes.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Authentication and sessions
- Affected Component: apps/api/src/auth/sessions.ts, apps/api/src/routes/auth.ts
- Reachability: Reachable via merchant login and OTP verify flow
- Original Contributors / Sources: AI code audit, BUG-001 static inspection

## 3. Root Cause

Promotion is implemented as a database flag update (`authenticated = true`) without generating a fresh token. Additionally, only the password step issues a Set-Cookie header with `maxAge: 600` (10 minutes); OTP verification updates `sessions.expires_at` in Postgres to 12 hours without issuing an updated cookie.

## 4. Affected Files and Functions

- `apps/api/src/auth/sessions.ts:50-64` — `promoteSession`
- `apps/api/src/routes/auth.ts:99-105,171-190` — login cookie and OTP response
- `apps/api/src/adminAuth/sessions.ts:67-77` — admin promote
- `apps/api/src/routes/adminAuth.ts:166-187` — admin token re-issue
- `apps/web/src/pages/dashboard-login/LoginPage.tsx:76-88`

## 5. Expected Behavior

Upon completing OTP verification, the application must rotate the session token to prevent fixation and issue a new Set-Cookie header matching the full 12-hour session lifetime.

## 6. Actual Behavior

Pending and authenticated phases share one bearer token. Anyone who obtained the pending cookie (XSS, shared device, Bug 1) keeps a fully authenticated session after the victim completes OTP. Merchant verify also never re-sets the cookie, so the browser `maxAge` stays at the 10-minute pending TTL while the server row is extended to 12 hours.

The browser credential expires at password-submission time plus `pendingSessionTtlMinutes`, while the server retains an authenticated session until OTP time plus `sessionTtlHours`.

## 7. Trigger Conditions

A merchant logs in with password and completes OTP verification. If an attacker stole the pending cookie, they retain full authenticated access. For legitimate users, browsing after 10 minutes results in sudden unauthenticated session drops.

## 8. Technical Evidence

Source review of `apps/api/src/auth/sessions.ts` and `apps/api/src/routes/auth.ts`.

- `apps/api/src/auth/sessions.ts:50-61` — `promoteSession` only sets `authenticated = true` and extends `expires_at`
- `apps/api/src/routes/auth.ts:171-190` — merchant verify does not `setCookie`
- `apps/api/src/adminAuth/sessions.ts:67-77` — admin promote, same missing rotation
- `apps/api/src/routes/adminAuth.ts:166-187` — admin re-issues the **same** raw token

Evidence from BUG-001:
`routes/auth.ts:99-105` sets `maxAge: app.config.pendingSessionTtlMinutes * 60`. OTP success at lines 171-190 calls `promoteSession` then sends JSON; there is no `setCookie` in that handler. `auth/sessions.ts:57-63` computes `Date.now() + sessionTtlHours * 3_600_000` and updates the row. The admin counterpart explicitly renews its cookie at `routes/adminAuth.ts:181`; this is not a framework-wide automatic behavior.

## 9. Runtime Evidence

No runtime reproduction artifact exists; statically confirmed via inspection of auth route handlers and session lifecycle helpers.

## 10. Security / Financial / Functional Impact

Session fixation. Legitimate merchant users also look "logged out" ~10 minutes after login even though the server session is still valid.

Premature loss of merchant authentication interrupts dashboard actions and requires repeated sign-in. This report does not claim account takeover or new financial side effects.

## 11. Safe Reproduction

In an isolated test browser or HTTP client, submit valid credentials, verify OTP, and observe Set-Cookie headers and token hash in `sessions` table.

## 12. Related Findings

Consolidates legacy Bug 5 and Blind Spot BUG-001. Related to Bug 1 (OTP bypass).

## 13. Documentation Contradictions

ARCHITECTURE claims pending session grants nothing and session tokens are cryptographically secure; code preserves pending bearer tokens across elevation.

## 14. Recommended Remediation

On promote, generate a new `randomToken(32)`, update `token_hash`, and `setCookie` with the full session TTL.

Also send `Set-Cookie` with `maxAge: app.config.sessionTtlHours * 3600` on successful OTP verification.

## 15. Remaining Questions and Limitations

None; route handlers directly confirm the absence of token rotation and Set-Cookie header.

## 16. Original Reports Merged

`bug-5-session-token-not-rotated-on-otp.md`, `bug-1-merchant-cookie-not-extended-after-otp.md`

## 17. Evidence References

`apps/api/src/auth/sessions.ts`, `apps/api/src/routes/auth.ts`, `apps/web/src/pages/dashboard-login/LoginPage.tsx`
