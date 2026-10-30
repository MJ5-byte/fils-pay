# BUG-051 — Webhook URL Registration Lacks Private Network and Localhost Validation (SSRF)

## 1. Summary

A merchant (or anyone who can create an endpoint) can set `url` to `http://settlement:8091/…`, `http://169.254.169.254/`, etc.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/testSend.ts, apps/api/src/routes/webhooks.ts
- Reachability: Reachable via webhook endpoint creation and test send
- Original Contributors / Sources: AI code audit

## 3. Root Cause

No allowlist / deny-private resolver.

## 4. Affected Files and Functions

- `apps/api/src/webhooks/create.ts:15-28` — no private-IP check
- `apps/api/src/webhooks/transport.ts:38-48` — `fetch` with default `redirect: "follow"`
- `apps/api/src/webhooks/testSend.ts` — echoes up to 2KB of the response back to the merchant

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A merchant (or anyone who can create an endpoint) can set `url` to `http://settlement:8091/…`, `http://169.254.169.254/`, etc. Redirects follow. Test-send returns the body, so it is a browser for the API container.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/create.ts:15-28` — no private-IP check
- `apps/api/src/webhooks/transport.ts:38-48` — `fetch` with default `redirect: "follow"`
- `apps/api/src/webhooks/testSend.ts` — echoes up to 2KB of the response back to the merchant

Technical details:
A merchant (or anyone who can create an endpoint) can set `url` to `http://settlement:8091/…`, `http://169.254.169.254/`, etc. Redirects follow. Test-send returns the body, so it is a browser for the API container.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

SSRF from the API to settlement's internal token endpoint, metadata services, and anything else on the compose network.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-43-webhook-url-ssrf.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Resolve the URL, deny RFC1918 / link-local / metadata IPs, `redirect: "manual"`. Do not echo response bodies from non-public hosts.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-43-webhook-url-ssrf.md`

## 17. Evidence References

`apps/api/src/webhooks/testSend.ts, apps/api/src/routes/webhooks.ts`, `bug-43-webhook-url-ssrf.md`
