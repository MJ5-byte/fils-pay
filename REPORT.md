# REPORT

### Bug: CSV import misreads BD amounts
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** A finance adjustment import with amounts 4.75, 5 and 4.755 posted 475, 500 and 475 fils to the merchant instead of 4750, 5000 and 4755, and 4.7555 was silently cut to 475 fils instead of being rejected.
- **Cause:** `apps/api/src/admin/adjustmentCsvParsing.ts:8` converted the amount with `parseDecimalMinor`, which assumes two decimals (cents), while BD has three decimals and 1 BD is 1000 fils (ADR-0001).
- **Breaks:** Every imported adjustment credited or debited a tenth of the intended amount, and extra decimals were dropped without an error, so merchant balances drifted from what finance uploaded.
- **Fix:** The import now parses each amount with the shared `parseBhdToFils` from `packages/money`, the parser ADR-0001 requires, so "4.75" is 4750 fils and an amount with more than three decimals rejects the upload with `invalid_amount`. Eight existing test assertions that pinned the two-decimal result were updated. Test added.
### Bug: Capture idempotency ignores the transaction
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** Capturing a second transaction with an Idempotency-Key already used on another transaction returned the first transaction's capture result with 200, and the second transaction was never captured.
- **Cause:** `apps/api/src/payments/capture.ts:92` built the idempotency request hash from the amount only, and keys are claimed per merchant and endpoint, so the same key and body on a different transaction looked like a replay.
- **Breaks:** A merchant who reuses a key gets a success answer for money that was never captured, and the authorized hold on the second transaction is left behind.
- **Fix:** The capture request hash now includes the transaction id, the same way refunds already do, so a key reused on a different transaction is refused with the existing `idempotency_key_reused` 422. Test added.
### Bug: Merchants can cancel other merchants' payment links
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A merchant could cancel another merchant's active payment link by sending its id under their own merchant path, and got 204.
- **Cause:** The cancel route only checks that the caller belongs to the path merchant (`apps/api/src/routes/paymentLinks.ts:104`), and `apps/api/src/paymentLinks/cancel.ts:13-19` cancels `WHERE id = $1` with no merchant condition.
- **Breaks:** Anyone with a merchant account who learns a link id can stop another merchant's customers from paying them.
- **Fix:** `cancel.ts` now matches the link on both its id and the path merchant in the update and in the follow-up lookup, so another merchant's link answers the same 404 as a missing one and its existence is not revealed. Test added.
### Bug: Expired payment links can still be paid
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A buyer could pay a payment link after it expired by sending an old `submittedAt` time with the payment; the link was marked paid after its expiry.
- **Cause:** The public, unauthenticated pay route (`apps/api/src/routes/paymentLinks.ts:157,166` before this fix) passed the buyer's `submittedAt` into `payPaymentLink`, which used it as the expiry clock (`apps/api/src/paymentLinks/pay.ts:34-38,73`), although the route's own contract says `submittedAt` is ignored without an API key.
- **Breaks:** Any merchant's expiry date meant nothing: anyone holding a link could pay it at any time by choosing the clock it was judged by.
- **Fix:** The public pay route no longer forwards `submittedAt`, and `payPaymentLink` no longer accepts it, so expiry is always judged by the server's clock, as the route documents. Test added.
### Bug: Bulk KYC approves rejected merchants
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** Selecting merchants in the admin list and bulk-approving their KYC also approved merchants that finance had already rejected, and left no KYC review record for any of them.
- **Cause:** `apps/api/src/admin/bulkKyc.ts:27-30` ran `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true WHERE id = ANY($1)` with no `under_review` predicate, although its own contract (`:12-13`) says rejected ids are skipped. It also wrote `kyc_passed` directly instead of through `recordKycReviewInTx` (`apps/api/src/onboarding/review.ts`), which migration 0016 names as the only writer, so no `merchant_kyc_reviews` row was written. The admin list's select-all includes rejected merchants.
- **Breaks:** A merchant that failed KYC became approved and could take payments again, with no review trail showing who approved it.
- **Fix:** The bulk approval now locks only the selected merchants still `under_review` and approves each through `recordKycReviewInTx`, the same function the single review uses, so each gets its review row with the admin's email and id. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/14
### Bug: Any merchant can read split-child reports
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** Any merchant could read another merchant's split-child transactions by putting that child's merchant id in the transactions report filter.
- **Cause:** `apps/api/src/reporting/scope.ts:12-15` only checked that the requested merchant was a split child of anyone, not that the caller was its parent.
- **Breaks:** Cross-tenant data leak: transaction amounts, statuses and references of every split-child merchant were readable by any logged-in merchant.
- **Fix:** The scope check now requires a `merchant_split_children` row with the caller as parent and the requested merchant as child. Test added.
### Bug: Login works without the OTP code
- **Status:** Fixed
- **Type:** Security, critical
- **Problem:** After entering only the password, a merchant user could open the dashboard and call the API without ever entering the OTP.
- **Cause:** `lookupSession` (`apps/api/src/auth/sessions.ts:89-92`) reads the view `live_sessions` (migration 0058), which filters revoked and expired sessions but not `authenticated`, so the pending session created after the password (`apps/api/src/routes/auth.ts:87,99`) passed every merchant route.
- **Breaks:** A stolen password alone took over a shop's account, including its transactions and API keys.
- **Fix:** Added `AND s.authenticated = true` to `lookupSession`, the shared lookup behind every merchant route. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/8
### Bug: Login can land in another merchant
- **Status:** Fixed
- **Type:** Security, critical
- **Problem:** A user whose email exists in two merchants could log in to merchant B with B's password and, after the OTP, end up in merchant A.
- **Cause:** `apps/api/src/routes/auth.ts:64` checks the password for the (merchant, email) pair, but `:78` binds the OTP and session to `findOtpRecipient`, which matches the email across all active merchants with `LIMIT 1` and no `ORDER BY` (`apps/api/src/auth/users.ts:19-20`).
- **Breaks:** Cross-tenant account takeover: anyone who signs up a merchant with a victim's email can be routed into the victim's merchant, or the victim into theirs.
- **Fix:** `findOtpRecipient` now filters on the merchant whose password was just checked; a route test with one email in two merchants fails before and passes after. PR: https://github.com/SilentYsf/fils-pay/pull/5
### Bug: Support admins can post money to merchants as credits
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** A support admin, the read-and-routine-ops role, could post a manual credit of up to 50 BD per call to any merchant, and it went straight to the ledger.
- **Cause:** The create route `apps/api/src/routes/adminCredits.ts:62-77` only had `requireAdminSession`, with no role check, while the approve and reject routes required finance or super_admin. Credits at or under the 50 BD threshold (`apps/api/src/admin/creditThreshold.ts:15`) post to the ledger on create (`apps/api/src/admin/credits.ts:253`). The admin UI hid the form from support, but the API did not.
- **Breaks:** Any support account could move money into a merchant's payable balance, up to 50 BD per call with no limit on calls, bypassing the maker-checker the credits plane is built around.
- **Fix:** Added `requireAdminRole("finance", "super_admin")` to the create route, matching approve and reject. Test added: support posting a credit gets 403 and nothing is journaled. PR: https://github.com/SilentYsf/fils-pay/pull/6

### Bug: Payment link tokens and login OTPs come from a predictable generator
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** Payment link tokens and the login OTP codes were drawn from `Math.random`, which is not a secure random source, so someone who sees enough outputs can predict the next ones.
- **Cause:** Both helpers in `apps/api/src/lib/random.ts:2-16` (`randomDigits` for OTPs via `apps/api/src/auth/otp.ts:8`, `randomFromAlphabet` for link tokens via `apps/api/src/paymentLinks/create.ts:12`) used `Math.random`. The repo's own agent notes call this acceptable for link tokens and OTP codes, which is false: both are bearer secrets.
- **Breaks:** A guessed link token opens another merchant's payment link, and a guessed OTP weakens the second login factor.
- **Fix:** Both helpers now draw each character with `crypto.randomInt` from `node:crypto`, which is secure and unbiased, so every caller is covered in one place and the formats (22 URL-safe characters per token, 6 digits per OTP) are unchanged. Test added: with `Math.random` stubbed to a constant, two tokens and two OTPs still differ.
### Bug: Merchant dashboard shows a different fee from what we charge
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** The admin merchant page showed Alpha's current negotiated rate as 2.45%, while a capture on Alpha charged 34 fils on 1500 fils, which is 2.25%.
- **Cause:** `getCurrentFeeScheduleForDisplay` (`apps/api/src/fees/currentFeeScheduleDisplay.ts:36`) picked the fee schedule with the latest `created_at` and no effective-date filter, so a backdated correction keyed in later (245 bps, effective 1 March, created 15 August) outranked the row in force (225 bps, effective 1 August). Capture uses the right rule in `apps/api/src/fees/feeSchedule.ts:30-31`.
- **Breaks:** Admins and merchants were shown a fee nobody was charged, and a schedule entered in advance would have shown as current before it applied. No money moved off the display.
- **Fix:** The display query now uses capture's rule: `effective_from <= now()`, newest `effective_from` first, ties broken by `created_at`. The existing test that asserted the backfill row wins now expects the rate in force, and a new test covers a future-dated row. Both fail before and pass after. PR: https://github.com/SilentYsf/fils-pay/pull/24

### Bug: Reconciliation page crashes on a negative gap
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** When a merchant's reconciliation gap was below zero, the Reconciliation page showed the router's "Unexpected Application Error!" screen instead of the numbers.
- **Cause:** The dashboard formatter `bhd()` (`apps/web/src/format.ts:11-12`) called `toFils` without `allowNegative`, so the signed `gapFils` rendered at `apps/web/src/pages/settlement/ReconciliationPage.tsx:115,131` threw "toFils: expected a non-negative amount" during render.
- **Breaks:** The page failed exactly when there was a gap to explain; a single payout (BHA-46) or a link payment (BHA-32) was enough to make the gap negative.
- **Fix:** `bhd()` now calls `toFils(amountFils, { allowNegative: true })`, so every dashboard amount can be negative; `formatBhd` already prints the minus sign. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/16
### Bug: Impersonation can capture and void payments
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** An admin using "View as merchant" could capture and void that merchant's payments, and the transaction events recorded the write as the merchant's own session, not the admin.
- **Cause:** `apps/api/src/admin/impersonation.ts:85-89` mapped finance to finance and super_admin to owner, against `docs/HANDOVER.md:57-58` and its own comment at `:91`, which say a grant is read-only `support`. Capture and void (`apps/api/src/routes/transactions.ts:95,123`) have no role gate, so even a support grant passed, and `requireMerchantWriterActor` (`apps/api/src/auth/requireMerchantAuth.ts:129-134`) attributes the write to `merchant_session`.
- **Breaks:** Any admin, support included, could move a merchant's money under the merchant's name, with no trace of which admin did it; a super_admin grant also opened owner/finance pages such as reconciliation.
- **Fix:** `requireMerchantAuth`, the shared auth behind every merchant route, now refuses any non-GET/HEAD request that resolves to an impersonation grant, and `lookupImpersonationGrant` maps every admin to the `support` merchant role. Since a grant can no longer write, no write is ever attributed to it. Test added in `apps/api/src/routes/admin.test.ts`: support and super_admin grants get 403 on capture, void and reconciliation, and the transaction stays authorized. PR: https://github.com/SilentYsf/fils-pay/pull/15
### Bug: Key rotation leaves the old API key working
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** After an admin rotated a merchant's API key, the old key still answered 200 on every API-key route, so a leaked key stayed valid.
- **Cause:** `rotateApiKeyAsAdmin` (`apps/api/src/admin/apiKeys.ts:31-36`) issued the replacement key and wrote the audit row but never set `revoked_at` on the key it replaced, so `verifyApiKey` (`apps/api/src/apiKeys/verify.ts:19`) kept accepting it. The route comment (`routes/adminMerchants.ts:175`), migration 0037 and `apiKeys/issue.ts:22` all describe rotation as revoke plus reissue; no ADR or doc defines a grace period.
- **Breaks:** Rotating a compromised key did nothing: whoever held the old key could keep charging cards, capturing, voiding and reading the merchant's transactions.
- **Fix:** The rotation now revokes the old key (`revoked_reason = 'rotated'`) in the same transaction that issues the new one and writes the audit row. The existing rotation test asserted the bug and now expects the old key to get 401 and the new one 200. PR: https://github.com/SilentYsf/fils-pay/pull/17
### Bug: rebuild-balances --merchant changes nothing
- **Status:** Fixed
- **Type:** Data, low
- **Problem:** An operator running `settlement rebuild-balances --merchant <id>` saw a rebuilt balance printed, but the merchant's cached balance stayed wrong.
- **Cause:** `RebuildMerchantBalance` (`apps/settlement/internal/ledger/rebuild.go:20`) only SELECTed the ledger sum and never wrote `merchant_balances`, although `cmd/settlement/main.go:153` says it writes the cache like the full rebuild.
- **Breaks:** A per-merchant repair of a drifted balance silently did nothing; only the all-merchant rebuild actually fixed it.
- **Fix:** The function now upserts `merchant_balances` with the ledger sum in the same statement, matching `RebuildAllBalances`. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/26
### Bug: Export summary fails on every call
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** `GET /v1/reporting/export-summary` answered 500 for everyone, signed in or not.
- **Cause:** The route at `apps/api/src/routes/reporting.ts:79` had no `requireMerchantAuth` preHandler, unlike every other reporting route, so `request.merchantAuth` was undefined when the handler read `merchantId`.
- **Breaks:** The export summary was unusable, and an anonymous caller got a 500 instead of a 401.
- **Fix:** Added `{ preHandler: requireMerchantAuth }` to the route, as its neighbours have. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/27
