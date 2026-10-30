# Bug 46 — Creating a credit does not require a finance role

**Severity:** High · **Area:** Admin · **Clue:** Handwritten — *"some admin actions don't seem to have the right role checks"*

## Where
- `apps/api/src/routes/adminCredits.ts` — `POST /merchants/:id/credits` is only `requireAdminSession`
- Approve/reject correctly require `finance` | `super_admin`
- `createCreditRequest` can auto-post when under the dual-control threshold

## What's wrong
Any logged-in admin, including `support`, can create a credit. Under-threshold requests post to the ledger immediately.

## Why
Role check was added to the approve path and forgotten on create.

## What it breaks
Support can move money. Combined with Bug 45, a single operator can also approve the rest.

## Smallest fix
`requireAdminRole("finance", "super_admin")` on create, same as approve.
