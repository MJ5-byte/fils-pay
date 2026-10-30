# Bug 58 — `/v1/reporting/export-summary` has no auth hook

**Severity:** High · **Area:** Reporting · **Clue:** Architecture merchant-scoped queries; related to Bug 52

## Where
- `apps/api/src/routes/reporting.ts:79-86` — no `preHandler: requireMerchantAuth`, but the handler reads `request.merchantAuth!.merchantId`

## What's wrong
Sibling reporting routes attach `requireMerchantAuth`. This one does not. Unauthenticated calls either 500 on the non-null assertion or, if a plugin stamped a stale identity, leak another merchant's export summary.

## Why
Copy-paste route missing the preHandler.

## What it breaks
Unauthenticated 500s, or a cross-tenant data leak if `merchantAuth` is ever populated without this hook.

## Smallest fix
Add the same `preHandler: requireMerchantAuth` as the other reporting routes.
