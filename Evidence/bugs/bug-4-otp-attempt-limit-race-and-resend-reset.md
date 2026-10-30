# Bug 4 — OTP attempt limit is racy, and resend resets the guess budget

**Severity:** High · **Area:** Auth · **Clue:** Handwritten note — OTP safety

## Where
- `apps/api/src/routes/auth.ts:135-168` — verify: read `attempt_count`, then a separate UPDATE
- `apps/api/src/routes/adminAuth.ts:126-159` — same pattern (comment says `FOR UPDATE`; the SELECT does not)
- `apps/api/src/routes/auth.ts:194-228` — resend comment says attempts are inherited; `issueChallenge` inserts a new row with default `attempt_count = 0`

## What's wrong
1. The max-attempts check is not atomic. Concurrent `/otp/verify` requests all see `attempt_count = 0` and each get a guess.
2. Resend consumes the old challenge and inserts a new one. Attempts start at zero every 30 seconds.

## Why
Check-then-increment without a row lock; new challenge row per resend with no copied counter.

## What it breaks
Online brute force of a 6-digit code (worse with Bug 3). `max_attempts` (default 5) is not an actual limit.

## Smallest fix
`SELECT … FOR UPDATE` (or a single `UPDATE … WHERE attempt_count < max_attempts RETURNING …`). Pass the previous `attempt_count` into `issueChallenge` on resend.
