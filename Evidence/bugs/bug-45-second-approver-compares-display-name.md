# Bug 45 — Dual-control credit approval compares display names, not user ids

**Severity:** High · **Area:** Admin · **Clue:** HANDOVER — *"The second approver is compared by admin user id."*; handwritten role-check note; agent files say displayName is intentional

## Where
- `apps/api/src/admin/creditApproval.ts:10-13`

```ts
if (approver.displayName === requester.displayName)
```

## What's wrong
Two different admins named "Fatima" cannot approve each other's credits. One person with two accounts and different display names **can**. HANDOVER's invariant is the opposite of the code.

## Why
Matched to "the audit log format" (decoy JSDoc).

## What it breaks
Maker-checker is not maker-checker. Credits above threshold can be self-approved.

## Smallest fix
Compare `adminUserId` only.
