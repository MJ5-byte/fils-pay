# REPORT

### Bug: Payout disbursement rows duplicate on webhook replay
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** One paid settlement batch got a new payout disbursement record every time its `settlement.paid` webhook was replayed and for every extra webhook endpoint, so one payout showed up as two or three disbursements.
- **Cause:** The dispatcher runs the disbursement effect for any delivery at attempt 0 (`apps/api/src/webhooks/dispatcher.ts:160-163`), and `recordPayoutDisbursementEffect` (`apps/api/src/webhooks/payoutDisbursement.ts`) inserted a row unconditionally. Replays insert a new delivery at attempt 0 and there is one delivery per endpoint, so the record was keyed to webhook deliveries instead of to the payout.
- **Breaks:** Every replay or extra endpoint instructs another disbursement of the same batch's net payout, which can pay a merchant twice.
- **Fix:** `recordPayoutDisbursementEffect` now locks the batch row (`SELECT ... FOR UPDATE`) inside one transaction, reads `net_payout_fils` from that locked row instead of the webhook payload, skips void batches, checks for an existing disbursement and inserts only when there is none, so concurrent dispatch passes serialize on the batch. The unique index on `settlement_payout_disbursements (settlement_batch_id)` remains a follow-up that waits for a human's approval. Test added.
### Bug: Merchants can't verify our webhook signatures
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A merchant who checks the HMAC of the webhook body they received gets a mismatch on every delivery and every test send, so they must either reject our webhooks or skip verification.
- **Cause:** `apps/api/src/webhooks/dispatcher.ts:158` signs the payload with sorted keys (`canonicalJson` inside `signPayload`), but `:172` sends `JSON.stringify` of the stored jsonb payload in Postgres key order; `apps/api/src/webhooks/testSend.ts:57,62` does the same with insertion order. The signed bytes and the sent bytes differ.
- **Breaks:** Merchants cannot tell a genuine FilsPay webhook from a forged one, which defeats the point of signing.
- **Fix:** `signPayload` in `apps/api/src/webhooks/sign.ts` now also returns the exact string it signed, and both the dispatcher and the test send use that string as the request body. The signature scheme and header format are unchanged. Test added.
### Bug: Refunds pay out twice and can exceed the charge
- **Status:** Fixed
- **Type:** Money, critical
- **Problem:** Two refunds of one transaction sent at the same time both paid out, and a partially captured transaction could be refunded up to its full authorized amount.
- **Cause:** `apps/api/src/payments/processRefund.ts` read the transaction without a row lock (`:73-78`), called the acquirer outside any transaction (`:146`) and then wrote an absolute `refunded_fils` from that stale read (`:199`); its ceiling was the authorized amount minus refunds (`:90`), not the captured amount.
- **Breaks:** Once `POST /v1/refunds` is wired, a merchant could pay a customer back twice while the books record one refund, or return more money than was ever taken from the card.
- **Fix:** `processRefund` now runs in one transaction that locks the row with `FOR UPDATE` and holds it across the acquirer call, the same shape as `capture.ts`, caps refunds at captured minus refunded, and increments `refunded_fils` in SQL. Test added.
### Bug: Incoming signature check can be bypassed
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** An acquirer callback sent with no signature header was accepted with 200 and applied, so anyone could post a fraud review outcome.
- **Cause:** `apps/api/src/webhooks/inboundVerify.ts:52-55` accepts a missing header unless signatures are required, and `apps/api/src/config.ts:259` defaulted `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` to false.
- **Breaks:** A forged, unsigned callback could mark a transaction's fraud review with any outcome the attacker chose.
- **Fix:** The signature is now required by default in `config.ts` and in `verifyAcquirerCallbackSignature`; skipping it needs an explicit `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false`. The existing unsigned-callback test asserted the bug (200); it now expects 401 and no note written.
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
### Bug: Webhook test-send is a blind SSRF into internal services
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A merchant could register a webhook endpoint pointing at an internal address (`http://127.0.0.1:<port>/...`, a private service, or the cloud metadata address `169.254.169.254`) and then call test-send, which returned up to 2000 characters of whatever that address answered.
- **Cause:** `validateWebhookUrl` (`apps/api/src/webhooks/create.ts:15`) only checked the scheme, and the transport `createFetchTransport` (`apps/api/src/webhooks/transport.ts:33`) called `fetch` on the raw URL with no address check; comments there claimed create.ts already blocked private IPs, which it did not. `sendTestWebhookEvent` (`apps/api/src/webhooks/testSend.ts:68`) echoed the first 2000 bytes of the response back to the merchant.
- **Breaks:** Any merchant could read internal, unauthenticated services and cloud metadata through the test-send response, a blind-to-full SSRF.
- **Fix:** The transport now sends with node's http/https request and refuses, at send time, to connect to loopback, private, link-local, unique-local or unspecified addresses (IPv4, IPv6 and IPv4-mapped IPv6), checking the address actually resolved from DNS so a rebind cannot slip past, and never follows redirects. Create and update reject an obviously internal URL early with a 400. Loopback/private targets are allowed only when `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (default false), for local dev and tests. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/23

### Bug: The public payment link page hands out the merchant's API key hash
- **Status:** Fixed
- **Type:** Security, low
- **Problem:** Anyone holding a payment link could call `GET /v1/payment-links/:token` without logging in and get back `merchantIntegrationId`, the sha256 `key_hash` of the merchant's newest live API key, and `merchantPublicKey`, the first 16 characters of that raw key.
- **Cause:** `getPublicPaymentLink` (`apps/api/src/paymentLinks/read.ts:43-44`) joined the newest unrevoked `api_keys` row and returned `key_hash` and `key_prefix` in the public response, although the DTO's own comment (`read.ts:18`) says it carries nothing that identifies or authenticates the merchant beyond its display name. Nothing in the checkout page, the dashboards or the docs reads either field.
- **Breaks:** The hash of a bearer key lets an attacker test key guesses offline, the prefix gives away part of the secret, and both tie every link back to the same merchant key.
- **Fix:** Removed both fields and the `api_keys` join from the public read; the remaining fields are unchanged. Test added: the public response must not contain the link's merchant key hash or prefix. PR: https://github.com/SilentYsf/fils-pay/pull/20
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
### Bug: Suspended merchants keep money access
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** After a merchant was suspended or closed, anyone already logged in, and every API key it had issued, could still list transactions, capture, void and authorize new charges, and buyers could still pay its open payment links.
- **Cause:** Only login checked `merchants.status`. The session lookup (`apps/api/src/auth/sessions.ts:89-93`) and the API-key lookup (`apps/api/src/apiKeys/verify.ts:19`) never looked at it, and every merchant route trusts those two. The public link pay route has no session or key at all, and `apps/api/src/payments/authorize.ts:78-89` checked only `onboarding_status`.
- **Breaks:** Suspension did not stop a merchant from taking or moving money until its sessions expired and its keys were revoked by hand.
- **Fix:** Both lookups now join `merchants` and require `status = 'active'`, so existing sessions and keys answer 401 the moment a merchant is suspended. `authorizeTransaction` also refuses a merchant that is not active with 403 `merchant_not_active`, which closes link payments. Tests added. PR: https://github.com/SilentYsf/fils-pay/pull/28
### Bug: Shops get two "your payout is on the way" messages
- **Status:** Fixed
- **Type:** Concurrency, medium
- **Problem:** A shop could get the `settlement.paid` webhook ("your payout is on the way") twice for one payout.
- **Cause:** `EnqueuePayoutNotifications` (`apps/settlement/internal/settlement/payout_notify.go:32-43`) checks `NOT EXISTS` for the batch's event and then inserts it in a separate statement (`:86`), with no transaction around the two and no unique index on `outbox_events` (migration 0009) to stop a second row; the comment at `:27` claiming such an index was false. The daemon tick and `run-batch` both call it, so two passes running at once both saw no event and both inserted one.
- **Breaks:** Duplicate payout notifications to merchants, and every consumer of `settlement.paid` sees the same payout twice. No money moves from the event itself.
- **Fix:** Each insert now runs in its own transaction that locks the batch row (`SELECT ... FOR UPDATE`) and inserts only `WHERE NOT EXISTS`, so a second pass waits for the first and then finds its event. No schema change. The false comment is corrected. Test added: two passes held at a lock and released together enqueue one event (two before the fix). PR: https://github.com/SilentYsf/fils-pay/pull/29
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
