# BUG-069 — Webhook Dispatcher Queue Lacks Row Claim Mechanism Causing Duplicate Dispatch

## 1. Summary

Two API processes can both read the same pending row and both POST it.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Webhooks
- Affected Component: apps/api/src/webhooks/dispatcher.ts
- Reachability: Reachable when dispatcher ticks concurrently
- Original Contributors / Sources: AI code audit

## 3. Root Cause

The "one replica" comment and the "SKIP LOCKED" comment describe different designs. Neither matches a second replica, which staging comments say has been running.

## 4. Affected Files and Functions

- `apps/api/src/webhooks/dispatcher.ts:217-227` — Step B selects `status = 'pending'` with no `FOR UPDATE SKIP LOCKED`
- The same query joins `webhook_endpoints` for the URL and does not require `we.status = 'active'`
- `apps/api/src/index.ts` comment says replicas are safe because of `SKIP LOCKED`. That clause is not in this query. Step A (creating rows) does filter `we.status = 'active'`.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Two API processes can both read the same pending row and both POST it. A pending delivery created while the endpoint was active is still sent after the endpoint is disabled, and it is sent to whatever URL is on the row now, including one edited after the event.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/api/src/webhooks/dispatcher.ts:217-227` — Step B selects `status = 'pending'` with no `FOR UPDATE SKIP LOCKED`
- The same query joins `webhook_endpoints` for the URL and does not require `we.status = 'active'`
- `apps/api/src/index.ts` comment says replicas are safe because of `SKIP LOCKED`. That clause is not in this query. Step A (creating rows) does filter `we.status = 'active'`.

Technical details:
Two API processes can both read the same pending row and both POST it. A pending delivery created while the endpoint was active is still sent after the endpoint is disabled, and it is sent to whatever URL is on the row now, including one edited after the event.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Merchants receive the same event twice. A disabled or retargeted endpoint still gets traffic, which also widens Bug 43 (SSRF) after the URL is changed.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: AI code audit. Legacy file: `bug-63-webhook-delivery-no-claim.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Claim the row (`UPDATE … WHERE status = 'pending' … RETURNING`, or `FOR UPDATE SKIP LOCKED` plus a status flip) before the HTTP call. Join `we.status = 'active'` in the due query, and snapshot the URL onto the delivery row when it is created.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-63-webhook-delivery-no-claim.md`

## 17. Evidence References

`apps/api/src/webhooks/dispatcher.ts`, `bug-63-webhook-delivery-no-claim.md`
