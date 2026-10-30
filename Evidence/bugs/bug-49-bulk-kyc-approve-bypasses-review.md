# Bug 49 — Bulk KYC approve skips the review workflow

**Severity:** High · **Area:** Admin / KYC · **Clue:** Handwritten role-check note; Architecture KYC review

## Where
- `apps/api/src/admin/bulkKyc.ts:26-31` — `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true` with no `under_review` guard and no `merchant_kyc_reviews` row
- Contrast: `apps/api/src/onboarding/review.ts` writes a review row per merchant

## What's wrong
Merchants who never submitted, or who were rejected, can be flipped to approved in bulk. There is no reviewer identity on a `merchant_kyc_reviews` row.

## Why
A convenience endpoint that updates the flag and skips the function that exists for the real path.

## What it breaks
Unreviewed shops take live traffic. Audit cannot say who approved them.

## Smallest fix
`WHERE onboarding_status = 'under_review'` and call `recordKycReviewInTx` per id.
