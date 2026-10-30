# Bug 59 — Credits post on a chosen date, reverse today's MDR, and split under the cap

**Severity:** High · **Area:** Money / admin · **Source:** CODE-011, FINDING-031

## Where
- `apps/api/src/admin/creditRequestValidation.ts:12-13,76-82` — doc says future dates are rejected; the code only checks that the string is a real calendar day
- `apps/api/src/admin/credits.ts:149-172,221-228` — ledger `occurred_at` is Bahrain midnight of `effectiveDate`; fee reversal uses `merchants.mdr_bps`
- `apps/api/src/admin/creditThreshold.ts:10-16` — second approver only when `baseAmountFils > 50_000`

## What's wrong
Any real `YYYY-MM-DD`, including tomorrow and a closed month, is accepted, and both ledger legs are dated that day. The fee handed back is the merchant's current default rate, not the `fee_schedules` rate charged at capture. Approval looks at the base amount only, with no daily total, so two credits of 50.000 BD each post with one operator. Exactly 50 000 fils does not trip the check (`>` not `>=`).

## Why
The validator's comment describes a rule the function does not implement. The threshold ignores the fee reversal on purpose (comment in `credits.ts`); nothing sums the day's credits.

## What it breaks
A credit lands inside an already-closed settlement period. The reversal does not match the fee that was charged. Support-or-finance (see Bug 46) can move arbitrary money by staying at or under 50.000 BD per request.

## Smallest fix
Reject `effectiveDate` after today (Bahrain). Reverse the fee from the schedule that applied to the original capture, or do not reverse a fee that was never charged. Compare admin user ids is Bug 45; here, compare the sum of credits for the merchant that day, and use `>=` on the threshold.
