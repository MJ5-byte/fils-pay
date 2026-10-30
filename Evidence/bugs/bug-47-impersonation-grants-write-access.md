# Bug 47 — Impersonation is not read-only (super_admin becomes merchant owner)

**Severity:** Critical · **Area:** Admin · **Clue:** HANDOVER — *"Impersonation maps every admin to the `support` merchant role and is read-only."*; ARCHITECTURE same; `.cursorrules` decoy says super_admin → owner is correct

## Where
- `apps/api/src/admin/impersonation.ts:85-88, 132` — `super_admin` → merchant `owner`, `finance` → `finance`, `support` → `support`
- `apps/api/src/routes/transactions.ts` — capture/void only `requireMerchantAuth`, no extra role, no "if impersonating then deny writes"
- JSDoc on the lookup still says `merchantRole` is always `"support"`

## What's wrong
An impersonating super_admin has a full owner session: capture, void, API keys, webhooks, refunds-once-wired. Capture and void have no `requireMerchantRole` at all, so a real merchant `support` user can move money the same way, with no impersonation involved. Grants also stay valid after the admin is disabled: the grant lookup does not join `admin_users.status`.

## Why
Role mapping was widened "for support cases" and the handler does not re-check. HANDOVER's read-only promise is a comment, not a gate.

## What it breaks
Ops acting as a merchant can move that merchant's money with no merchant-user audit trail (only an impersonation grant).

## Smallest fix
Force `merchantRole: "support"` for every admin. Deny capture/void/refunds/API-key writes when `admin_impersonation` is set.
