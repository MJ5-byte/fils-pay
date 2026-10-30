# Bug 2 — OTP and session bound to a different merchant (cross-tenant takeover)

**Severity:** Critical · **Area:** Auth · **Clue:** Finance group chat — *"Login works without entering the OTP code?"* combined with this lookup; handwritten note — OTP safety

## Where
- `apps/api/src/routes/auth.ts:60-97` — password is checked against `(merchantId, email)`, then discarded
- `apps/api/src/auth/users.ts:10-23` — `findOtpRecipient`

## What's wrong
Password verification uses the requested merchant. OTP and the pending session then use `findOtpRecipient(email)`, which picks **any** active merchant user with that email (`LIMIT 1`, no `merchant_id`, no `ORDER BY`). Challenge, session, and the emailed code all go to `recipient.id`.

## Why
A global email lookup after a tenant-scoped password check. Email is unique per merchant, not globally.

## What it breaks
- OTP is sent to another merchant's inbox if the same email exists there.
- Combined with Bug 1, an attacker who knows **their own** password on merchant B can operate as the victim on merchant A.

## Smallest fix
Use the `user` row from the login query for `issueChallenge`, `createPendingSession`, and `sendOtpCode`. Remove `findOtpRecipient`. Test two merchants sharing an email.
