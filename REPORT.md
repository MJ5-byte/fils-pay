# REPORT

### Bug: One payment link charged twice
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** When a payment took longer than 60 seconds, a second pay request on the same link charged the customer again, and both requests answered "paid".
- **Cause:** A reclaim after the 60 second timeout ran a fresh authorize and capture because the idempotency keys were scoped to the buyer's own key, and finalize's 0-row branch still answered 200 "paid".
- **Breaks:** A slow acquirer turns one invoice into two charges on the customer's card, which is what happened on 2026-05-14 (every double charge had a first attempt over 60 seconds).
- **Fix:** The authorize and capture idempotency keys are scoped to the link and its reservation (`pay.ts`), so a reclaim replays the first attempt's charge instead of making a new one, and `card` stays in the authorize hash (`authorize.ts:52`) so a different card cannot ride the first card's charge. A reclaim whose card differs hashes differently, so it answers 409 processing without touching the first buyer's reservation. A transient acquirer 502 seals that reservation's authorize key under a row lock and then releases the link (`pay.ts` settleFailedAuthorize), so the link stays payable by any card and cancelable instead of stranded, while a sibling still finalizing its own successful charge is left untouched. Finalize answers "paid" only when the link records this transaction, otherwise 409. The pay route validates the card (`assertValidCard`) before the link is reserved, so a malformed card such as `card: {}` answers 400 and leaves the link payable. Known limit: a link whose first buyer crashed mid-payment can only be finished with that buyer's card until the reservation expires, because cancel only accepts active links. No schema change. Tests added.
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
### Bug: MDR recalculation changes batches already paid out
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Running "Recalculate MDR" after a rate change rewrote the fee and net payout of batches that had already been paid, and posted a fee adjustment against them, so the paid history no longer matched what was disbursed.
- **Cause:** The batch scan in `apps/settlement/internal/settlement/recalculate_mdr.go:67` selected `status <> 'open'`, which includes `paid`, although the route contract (`apps/api/src/routes/admin.ts:51-53`) and the function's own doc comment promise paid batches are never modified.
- **Breaks:** A paid batch's `net_payout_fils` and fee change after the money left (a 23422 fils payout became 23372 locally), statements stop matching disbursements, and a fee adjustment is posted against a period whose payout was already final.
- **Fix:** The scan now selects only `status = 'closed'` batches; its row lock re-checks the status, so a batch paid while the recalculation waits is skipped as well. Test added: one paid and one closed batch in range, only the closed one changes. PR: https://github.com/SilentYsf/fils-pay/pull/22
### Bug: Large settlement batches pay out a few fils wrong
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Some settlement batches paid the merchant one or two fils more or less than gross minus fee; 13 of 80 exported batches were off.
- **Cause:** `NetPayableFils` (`apps/settlement/internal/settlement/payable.go:11`) did the subtraction in float32 BD, which holds whole numbers exactly only up to 16,777,216, so larger batches rounded. Its result is frozen as `net_payout_fils` (`batch.go:219,234`) and paid out (`batch.go:342`).
- **Breaks:** Payouts disagree with the ledger by a few fils, against ADR-0001 (whole fils only), and reconciliation never closes.
- **Fix:** `NetPayableFils` now returns gross minus fee in int64 fils. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/19
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
### Bug: Recompute statuses turns test merchants into live ones
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Test merchants kept showing up in the real settlement run. Running the admin "Recompute statuses" tool on a test merchant with open authorizations reported 0 open authorizations and switched `test_mode` off; the same tool also rewrote charged-back transactions to captured or refunded.
- **Cause:** `apps/api/src/admin/transactionStatusRecompute.ts:29` selected rows with `status NOT IN ('authorized', 'voided')` and then counted `authorized` among them (`:47`), which is always 0, so `apps/api/src/admin/merchantFlags.ts:10-16` cleared `test_mode`. That rule cleared it for any test merchant with no open authorizations at all, so even a correct count took test merchants live. Every selected row, chargebacks included, went through `nextStatusAfterRefund` (`apps/api/src/payments/refundState.ts:32`), which only knows capture and refund statuses. The Go close itself is correct: it filters `test_mode` (`batch.go:117,408`).
- **Breaks:** Fake shops' transactions went into real payouts and scheme exports, and a chargeback disappeared from the transaction's status, so it looked payable again.
- **Fix:** The route no longer calls the rule in `apps/api/src/admin/merchantFlags.ts` that switched `test_mode` off for any merchant with transactions and no open authorizations, so a status recompute never takes a test merchant live and `test_mode` changes only through an explicit admin action. The recompute query now excludes only voided rows; authorized rows are counted and left alone, and chargebacks are skipped, so only capture and refund statuses are recomputed. Tests added, including a route test where a test merchant with only captured transactions keeps `test_mode`. PR: https://github.com/SilentYsf/fils-pay/pull/21
### Bug: Reconciliation subtracts payouts twice
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** A merchant's reconciliation showed a negative gap equal to the payout (locally: ledger net -34, settlement net 23422, gap -23456) for any period that included the day a batch was paid.
- **Cause:** Paying a batch debits `merchant_payable` (`apps/settlement/internal/settlement/batch.go:340`), so the ledger figure in `apps/api/src/settlement/query.ts:288-293` already excluded the payout, and `:333` subtracted the batch's `net_payout_fils` again.
- **Breaks:** Reconciliation never ties out over any normal period, so finance cannot use it to spot real gaps.
- **Fix:** The ledger figure leaves out the payout legs (tagged with a `settlement_batch_id` and a `settlement payout:` description), so each payout is counted once, through the settlement figure. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/25
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
### Bug: "Recalculate cached balances" sets wrong balances
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Pressing the admin button dropped Alpha Retail's balance from about 136K BD to about 7K BD; only the CLI rebuild put it back.
- **Cause:** The button reached `apps/settlement/internal/internalapi/server.go:268`, which called `ledger.RefreshBalanceCache` (`internal/ledger/refresh.go:62`) reading view `merchant_payable_position` (migration 0054): lifetime gross from the scheme export, with no fees and no payouts. The CLI (`ledger.RebuildAllBalances`) sums the ledger, so ADR-0004's promise that the two agree could never hold.
- **Breaks:** One admin click overwrote every merchant's cached balance with a wrong figure, and anything reading the cache (payouts, the dashboard) followed it.
- **Fix:** The handler now calls `ledger.RebuildAllBalances`, the CLI's ledger walk, so the button, the CLI and the ledger sum agree; measured at 0.53 to 1.00 s through the live endpoint for 283 merchants and 7,294 ledger rows, well inside ADR-0004's 30 s timeout. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/35
### Bug: A balance rebuild during a payout puts the paid-out money back
- **Status:** Fixed
- **Type:** Concurrency, medium
- **Problem:** If a payout committed while a balance rebuild (the admin button or the CLI) was running, the merchant's cached balance ended up as if the payout never happened.
- **Cause:** `RebuildAllBalances` in `apps/settlement/internal/ledger/rebuild.go` summed the ledger and then overwrote `merchant_balances` without locking the rows first. A payout that had written its ledger debit and decremented the cache, but had not committed when the sum ran, was overwritten by the pre-payout sum once the rebuild's write went through.
- **Breaks:** The cache overstates what is owed to the merchant by the payout amount until the next clean rebuild, and anything that reads the cache follows it.
- **Fix:** The rebuild takes `LOCK TABLE merchant_balances IN EXCLUSIVE MODE` first in its transaction, before it reads the ledger, so a concurrent payout, credit or balance adjustment, even for a merchant with no cache row yet, is either counted or applied on top, and an adjustment's `SELECT ... FOR UPDATE` cannot deadlock with it. The settlement handler also reads the request body before rebuilding, so when the API gives up after 30 s the rebuild is cancelled and rolled back instead of committing after a reported failure. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/35
### Bug: OTP guess limit resets on every new login
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** Anyone who had a merchant's or admin's password could guess the 6-digit OTP without limit: after five wrong codes they logged in again and got five more guesses, as many times as they liked.
- **Cause:** The only guess limit was `max_attempts` on one challenge (`apps/api/src/routes/auth.ts:158`, `apps/api/src/routes/adminAuth.ts:148`), and every password login issues a fresh challenge with a fresh budget (`auth.ts:80-95`, `adminAuth.ts:74-89`). Nothing counted wrong codes per user across challenges.
- **Breaks:** The second factor only slows a password holder down instead of stopping them; at five guesses per login, a script is sure to hit the right code within 200,000 logins.
- **Fix:** Both login and OTP verify now sum `attempt_count` over the user's challenges created in the last 15 minutes and answer 429 `too_many_attempts` once that reaches 10, with the pending session revoked on verify. Verify counts, compares and records the guess in one transaction behind a `FOR UPDATE` lock on the user row, with a conditional increment, so parallel guesses cannot all read a count under the limit. The count comes from the existing challenge rows, so there is no schema change, and the check runs after the password, so nobody without the password can lock a user out. Test added for each plane. PR: https://github.com/SilentYsf/fils-pay/pull/36
### Bug: A merchant support user can capture and void payments
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A merchant user with the `support` role, from whom the dashboard hides the Capture and Void buttons, could still capture and void the merchant's payments by calling the API directly.
- **Cause:** The capture and void routes (`apps/api/src/routes/transactions.ts:94,121`) used only `requireMerchantAuth`, which accepts any signed-in merchant user, and no `requireMerchantRole`; the only gate was the hidden button in `apps/web/src/pages/transactions/TransactionDetailPage.tsx:168-174`, whose own comment said so.
- **Breaks:** A least-privilege support agent could move money: capture an authorization into the merchant's payable balance or void it and release the hold, recorded as that support session. Payment-link and webhook creation, which move no money, were already limited to owner and finance.
- **Fix:** Both routes now chain `requireMerchantRole("owner", "finance")` after `requireMerchantAuth`, the same gate the payment-link and webhook routes use. API keys still pass (they are owner-issued) and impersonation stays read-only. The two web comments that said the server had no such check are corrected. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/33
### Bug: Payout trends never show a batch as paid
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** The merchant overview's payout trends kept listing a batch as "closed" after it was paid, while the Settlement page showed the same batch as "paid".
- **Cause:** The trend row copies the batch's status once, when `settlement.batch_closed` is applied (`apps/reporting/src/consumer/applyEvent.ts:93-117`). Settlement does enqueue a `settlement.paid` event when the batch is paid out, but the consumer never reads it: it is missing from `REPORTING_EVENT_TYPES` (`apps/reporting/src/consumer/runConsumerPass.ts:9-13`), and migration 0028 wrongly says no such event exists.
- **Breaks:** Merchants are told a payout is still pending when it has gone out, and the trend's paid date stays empty.
- **Fix:** The consumer now reads `settlement.paid` and updates that batch's trend row with the status and paid date from `settlement_batches`. Test added.
### Bug: Catch-up beside the live worker counts events twice
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Running the reporting `catch-up` command while the worker was live (as the runbook allows) left dashboard capture counts and totals higher than the real activity.
- **Cause:** Every pass reads the consumer's watermark with a plain `SELECT` (`apps/reporting/src/consumer/cursor.ts:32`, called from `runConsumerPass.ts:43`). Two processes reading it before either commits both select the same events and both apply them; the `running` flag in `listener.ts` only guards passes inside one process, and the comments at `catchUp.ts:17` and `runConsumerPass.ts:16-18` claim a serialization that nothing enforced.
- **Breaks:** Captured counts and gross totals on the merchant dashboard are inflated by every event both processes applied.
- **Fix:** `readCursor` now reads the cursor row `FOR UPDATE`, so a second pass waits for the first to commit and then starts from the advanced watermark. Test added.
### Bug: One settlement close can freeze reporting
- **Status:** Fixed
- **Type:** Data, high
- **Problem:** Merchant dashboards stopped updating: the reporting consumer logged `TypeError: Cannot read properties of undefined (reading 'captured_count')` on every pass and applied no event after it.
- **Cause:** When a `settlement.batch_closed` event is applied, a parity check reads that day's `merchant_daily_volume` row and dereferences it without checking it exists (`apps/reporting/src/consumer/applyEvent.ts:147-148`). A day with captures in `transaction_events` but no applied capture event has no row, so the read throws, the whole pass rolls back and the watermark never moves past that event. The comment at `:76-77` promises such a case is a no-op.
- **Breaks:** Every later capture, void and payout stops reaching the dashboards until someone deletes the event by hand; the rebuild CLI fails the same way. It is also why the rebuild test and the three `runConsumerPass` end-to-end tests failed on a database that held such an event.
- **Fix:** A missing row now counts as a rollup of zero, so the check logs its "rollup lags ground truth" warning and the pass carries on. Test added.
### Bug: Disabled or logged-out admins keep impersonating merchants
- **Status:** Fixed
- **Type:** Security, low
- **Problem:** After an admin was disabled or logged out, their "view as merchant" grant cookie still opened the merchant's data until its 15 minute TTL ran out.
- **Cause:** `lookupImpersonationGrant` (`apps/api/src/admin/impersonation.ts:109`) joined `admin_users` but never checked its status; a code comment said an admin-disable trigger revokes grants, but none exists. Logout (`apps/api/src/routes/adminAuth.ts:206`) revoked only the admin session, and the grant lives in its own cookie.
- **Breaks:** A revoked admin kept read access to a merchant for up to 15 minutes after being disabled or signing out.
- **Fix:** The grant lookup now requires the admin to be active, and logout revokes the admin's open grants in the same transaction as the session. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/31
### Bug: The daily close runs at 3am instead of midnight
- **Status:** Fixed
- **Type:** Time, low
- **Problem:** The settlement daemon closed and paid each business day at about 03:15 Bahrain time; the brief says the close runs at midnight Bahrain time (UTC+3).
- **Cause:** `runIfDue` (`apps/settlement/internal/scheduler/daemon.go:80`) passed `time.Now().UTC()` to `BusinessDayWindow`, which takes the calendar date in the instant's own zone, so the daemon saw the day turn at UTC midnight, which is 03:00 in Bahrain.
- **Breaks:** Every daily close and payout ran three hours late. Each batch still covered the right Bahrain day, so no amounts were wrong.
- **Fix:** The daemon's day decision moved into `dueBusinessDate`, which converts `now` to Bahrain time (fixed UTC+3) before asking `BusinessDayWindow` for today's start; `BusinessDayWindow` is unchanged. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/30
### Bug: Reporting skips events that commit out of order
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Some captures and batch closes never reached the merchant dashboards, so daily capture counts and totals came out low, with nothing in the logs.
- **Cause:** The consumer keeps one high-water mark and reads `WHERE id > cursor` (`apps/reporting/src/consumer/runConsumerPass.ts:49`), assuming ids commit in order. They do not: settlement's `CloseBatch` inserts its `settlement.batch_closed` event and keeps its transaction open (`apps/settlement/internal/settlement/batch.go:268`) while the API commits later ids. A pass in that window applies the later ids and moves the mark past the one still being written, which is never read again. Migration 0030's note that the API is the only writer is false.
- **Breaks:** Any event whose transaction commits after a later id has been consumed is lost from the rollups for good, short of a full rebuild.
- **Fix:** A pass now walks every outbox id from the cursor in order and stops at a missing id. It records which transactions in this database are writing to `outbox_events` (every insert holds a `RowExclusiveLock` on it from before it draws its id until it ends) and waits until all of them have ended; it then reads the outbox once more and only skips the id if it is still missing. `catch-up` and `rebuild` retry a pass blocked at a gap instead of stopping. No schema change. Tests added, including a writer that starts inside a pass.
### Bug: Credit approval compares display names
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** Two different admins who share a display name could not approve each other's credit requests, while an admin whose display name differed from the one stored on the request would pass the self-approval check.
- **Cause:** `assertDistinctApprover` in `apps/api/src/admin/creditApproval.ts:11` decided whether the approver was the requester by comparing display names, but display names are neither unique nor fixed (`db/migrations/0031`, and 0060 snapshots the name because it changes). The request already stores the requester's admin id in `credit_requests.requested_by_admin_user_id`.
- **Breaks:** The two-person control on manual ledger credits: legitimate second approvers are refused, and once a display name changes an admin can approve and post their own credit to the ledger.
- **Fix:** The check now compares `adminUserId` of the requester and the approver; the only caller (`approveCreditRequest` in `admin/credits.ts`) already passes both ids. Tests added for the same admin under a different name (refused) and two admins sharing a name (allowed). PR: https://github.com/SilentYsf/fils-pay/pull/39
### Bug: Inbound acquirer callbacks are replayable and leak the HMAC via timing
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A captured, correctly-signed acquirer callback could be replayed at any later time, and the signature compare leaked the expected HMAC through response timing.
- **Cause:** `verifyAcquirerCallbackSignature` in `apps/api/src/webhooks/inboundVerify.ts` compared signatures with `Buffer.compare(...) === 0`, which short-circuits on the first differing byte and is not constant time, and it parsed the signed timestamp but never checked its freshness.
- **Breaks:** An attacker who observed one signed callback could replay it indefinitely, and the timing side channel helped forge a valid signature.
- **Fix:** The compare now uses the repo's constant-time `timingSafeEqualHex`, as `webhooks/sign.ts` already does, and a callback whose signed timestamp is older than a 300 second window is rejected with a new `stale_timestamp` reason. Additive: the require-signature behaviour from BHA-14 is unchanged and no existing reason was removed. No schema change. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/40
### Bug: Failed link captures strand the auth hold and bad capture amounts answer 500
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** When a payment-link capture failed terminally after the authorization succeeded, the customer's 7 day authorization hold was left active, stranding their funds for a week on a payment that did not go through. Separately, a malformed capture amount returned a 500 and a zero capture amount returned a misleading 422 instead of a clean 400.
- **Cause:** On a failed capture `payPaymentLink` (`apps/api/src/paymentLinks/pay.ts`) only released the payment-link reservation; it never voided the authorization, so the transaction stayed `authorized` with its `holds` row still `active` (`payments/authorize.ts`). The capture route in `routes/transactions.ts` called `toFils(amountFils)` with no guard, so `toFils`'s `RangeError` fell through to the generic 500 in `plugins/errorHandler.ts`; a zero amount passed `toFils` (zero is non-negative) and reached `captureTransaction`, which answered 422 `capture_exceeds_remaining`. (The equivalent guard on the authorize route landed separately in BHA-79.)
- **Breaks:** Buyers' funds held for 7 days on failed link payments; capture clients got a 500 (leaking an internal error) or a misleading 422 for bad input that should be a 400.
- **Fix:** On a **terminal** capture failure (402 decline, 409 not-capturable, 422 over-remaining) the pay path calls the existing row-locked `voidTransaction`, which releases the hold and moves the transaction to `voided`. A **transient** 502 (acquirer error, outcome unknown) is neither voided nor released: the charge may have gone through, so voiding would strand a real charge as `voided` with no ledger entry, and releasing would let a retry authorize a second time. The reservation stays, so a same-card retry once it goes stale resumes the same authorization through the reservation-scoped capture key (BHA-8) and pays the link with one transaction. The capture route now guards the amount (a positive whole number of fils) and returns a clean 400 `invalid_amount` before any acquirer call, the same guard the authorize route already applies (BHA-79), so a bad type no longer crashes into a 500 and a zero no longer reaches the 422 path. `VoidInput.actor` was widened to include the `system` actor the public link flow uses. Additive, no schema change. Tests: a failed (terminal) link capture voids and releases the hold; a 502 then a same-key retry still pays the link; a bad or zero capture amount each returns 400.
- **Known limit:** after a capture 502 the link stays reserved for that card's authorization, so only the same card can finish it, and only once the reservation goes stale; a different card gets 409 processing until then.
### Bug: Link payments skip the negotiated discount
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** The reconciliation page showed an unexplained negative gap after link payments by a merchant with a negotiated fee discount. The link ledger recorded the full MDR fee, never the discounted one; only direct API captures rebated the discount.
- **Cause:** The direct capture route (`apps/api/src/routes/transactions.ts`) calls `applyCaptureDiscountAdjustment` after a successful capture, but the public link pay path (`apps/api/src/paymentLinks/pay.ts`) captured and never called it. The comment claiming the discount "moved into capture.ts" was false; capture.ts applies no discount.
- **Breaks:** The ledger no longer matched settlement. Payouts were already correct, because Go `CloseBatch` applies the discount for every capture, but the ledger booked the merchant payable too low and fee revenue too high by the discount, surfacing as a negative reconciliation gap (measured at -34 fils on a 10.000 BD link, 0 with the fix).
- **Fix:** The link pay path now calls `applyCaptureDiscountAdjustment` right after the capture returns 200, the same shared function and the same call shape as the direct route. It runs in its own post-commit transaction (it reads back the committed fee and takes its own row lock), is idempotent, and is a no-op for merchants without a negotiated discount, so non-discounted link payments are unchanged. The call is wrapped so a failure after the committed capture is logged rather than thrown, which keeps a reserved link from being re-captured by a retry. Nothing re-runs a failed adjustment yet, so it stays logged for an operator. One test added, covering a discounted link payment: red before the fix (no rebate legs), green after. PR: https://github.com/SilentYsf/fils-pay/pull/44
### Bug: The settlement summary counts split captures twice
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** A merchant's settlement summary showed more captured money than they took: Alpha Retail's 1 August to 2 September summary said 1,500,000 fils for 5 transactions that captured 650,000 fils.
- **Cause:** `getSettlementSummary` (`apps/api/src/settlement/query.ts:368-380`) joined capture events to transactions and summed the running total `transactions.captured_fils` once per event, so a transaction captured in two parts counted its full total twice, and a part captured before the window still added its whole total.
- **Breaks:** The summary disagrees with what settlement actually pays out, so finance and merchants read inflated gross captured figures.
- **Fix:** The query now sums each capture event's own `amount_fils` inside the window, the same source the Go `CloseBatch` uses. Query timings are unchanged on the seeded data (1.56 ms to 1.53 ms); no index was added. Test added. PR: https://github.com/SilentYsf/fils-pay/pull/43
### Bug: Admin analytics rebuild double-applies outbox events
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** After an admin pressed Rebuild analytics, the next reporting pass counted again every capture, void and batch event the worker had not reached yet, so dashboard counts and gross came out high; the rebuilt totals also disagreed with the CLI `reporting rebuild`.
- **Cause:** `refreshAnalyticsRollups` (`apps/api/src/admin/reportingRebuild.ts:11-38`) truncated the rollups and refilled them from `transaction_events` and `settlement_batches`, but never touched `reporting_outbox_cursor`. Every event past the cursor was already in the refilled rows, and the worker then applied it on top. The route comment at `apps/api/src/routes/admin.ts:227-231` claimed the rebuild replayed the outbox; it did not.
- **Breaks:** Inflated merchant dashboard volumes after every admin rebuild while the worker was behind, and a read model filled two different ways that drift apart.
- **Fix:** The admin rebuild now does what `reporting rebuild` does: in one transaction it takes the cursor row first (the order a consumer pass locks in, so it waits for a running pass instead of deadlocking), rewinds it to 0 and empties both rollups, then notifies the worker, which replays the whole outbox through its normal consumer pass with the out-of-order gap wait. If a lock is not free within 5 seconds the rebuild gives up and answers 409 instead of stalling dashboard reads behind it. The route answers 202 and the admin page says the replay is running; dashboards show partial numbers until the replay catches up. Tests added. PR: https://github.com/SilentYsf/fils-pay/pull/47
### Bug: Seed prints plaintext API keys
- **Status:** Fixed
- **Type:** Security, low
- **Problem:** Running the seed printed every merchant's full raw API key to the terminal, so any log that captured seed output (CI or a deploy) kept live-usable keys in plaintext.
- **Cause:** `db/seed/generate.ts:913` logged `issued.rawKey` for each merchant, the one place the raw key is ever visible.
- **Breaks:** The rule never to log secrets: raw API keys end up in CI or deploy logs if the seed runs there.
- **Fix:** The seed now logs `issued.prefix`, the display-safe 16 character prefix already stored in `api_keys.key_prefix`, instead of the raw key. What the seed writes to the database is unchanged, so the keys still work for local dev; only the terminal output changed. No test: a seed log change is visible the moment the seed runs.

### Bug: Duplicate acquirer callbacks are saved twice
- **Status:** Fixed
- **Type:** Data, low
- **Problem:** When the acquirer redelivered the same async callback (same `callbackId`), the second copy was saved as a second identical note, so a transaction's timeline showed the same fraud-review verdict twice.
- **Cause:** `applyAcquirerCallback` in `apps/api/src/acquirer/callbacks.ts` did an unconditional `INSERT` into `acquirer_callback_notes`, and nothing enforced uniqueness on the acquirer's own `callback_id`. The dedupe the 1.9.0 postmortem, `CHANGELOG.md`, `HANDOVER.md` and migration 0051's comments claimed (a `processed_events` table, an FP-238 unique index) does not exist anywhere in the code or schema.
- **Breaks:** Duplicate payment history on the transaction timeline. This callback is informational only, so no money or status was affected.
- **Fix:** Added `ON CONFLICT (callback_id) DO NOTHING` to the insert, backed by a new additive migration (`db/migrations/0073_acquirer_callback_notes_dedupe.sql`) that creates a unique index on `acquirer_callback_notes (callback_id)`. A redelivery is now an atomic no-op, safe under concurrency. The migration is additive and needs a human to approve it before it runs in shared or hosted databases. Test added (the same callback fired twice concurrently yields one note).
### Bug: Web apps cannot reach the API (no CORS)
- **Status:** Fixed
- **Type:** Deploy, high
- **Problem:** The merchant dashboard (apps/web, dev 5173) and the admin console (apps/admin, dev 5174) run on their own origins and call the API cross-origin with the session cookie, but the API sent no CORS headers, so the browser blocked every request and nobody could log in.
- **Cause:** `buildApp` in `apps/api/src/app.ts` registered no CORS handling at all (no @fastify/cors, no header hook), so a preflight OPTIONS 404'd and responses carried no `Access-Control-Allow-Origin`.
- **Breaks:** Both front ends in any setup where they are not served from the API's own origin, including the hosted deploy (BHA-30).
- **Fix:** A minimal `corsPlugin` (`apps/api/src/plugins/cors.ts`), registered first in `buildApp`, adds an onRequest hook that, for an origin in the configured allowlist, echoes it back as `Access-Control-Allow-Origin`, sets `Access-Control-Allow-Credentials: true` and `Vary: Origin`, and answers the preflight OPTIONS (204 with allow-methods/headers/max-age). Unknown origins get no CORS headers, so nothing is blanket-allowed and no credentialed wildcard is ever sent. The allowlist is env-driven (`CORS_ALLOWED_ORIGINS`, comma-separated; `apps/api/src/config.ts`), empty in production unless set and a localhost dev default, so no production URL is baked into code. No new dependency was added; adding @fastify/cors would be cleaner and a human can approve that later. Test added.
### Bug: Paused webhook endpoints still receive queued deliveries
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** After a merchant paused (disabled) a webhook endpoint, deliveries already queued for it were still sent to its URL.
- **Cause:** Step B of the dispatcher (`attemptDueDeliveries` in `apps/api/src/webhooks/dispatcher.ts`) joined `webhook_endpoints` without checking its status; only Step A, which creates rows, required `status = 'active'`.
- **Breaks:** A merchant who disabled an endpoint (retired or compromised URL) kept sending payment payloads, signed with its secret, to that URL.
- **Fix:** Added `AND we.status = 'active'` to the Step B query. Held rows stay `pending` and go out on the first pass after the endpoint is active again. Test added in `dispatcher.test.ts`.

### Bug: Refunds never come off the merchant's payout
- **Status:** Fixed
- **Type:** Money, critical
- **Problem:** A refunded sale was still paid out to the merchant in full: the daily settlement batch counted the capture and never subtracted the refund, so the batch's net payout stopped matching the merchant's ledger by the refunded amount less the reversed fee.
- **Cause:** `CloseBatch` in `apps/settlement/internal/settlement/batch.go:148-158` selected only `captured` and `partially_captured` transaction events. Nothing in settlement ever read the `refunds` table, even though migration 0042 gave it a `settlement_batch_id` column and an unbatched index for exactly this claim.
- **Breaks:** Once `POST /v1/refunds` is live, every refund is money returned to the customer and also paid to the merchant, and reconciliation shows an unexplained gap.
- **Fix:** `CloseBatch` now claims the merchant's unbatched succeeded refunds dated before the end of its business day, oldest first, under the same row lock and batch id as the capture events. A refund that would push the batch's net below zero stays unclaimed and carries to the next batch that can absorb it, because a payout cannot collect money back; `PayoutBatch` and the balance cache now refuse a negative payout instead of marking it paid and writing it off. It takes the refunded amount out of gross and the fee recorded in `fee_reversed_fils` out of fee, so net = captures - fees - refunds + reversed fees in integer fils and still equals gross - fee. A refund made after its sale's batch was paid comes off a later batch, from the day the refund happened, the same day its ledger legs are dated. A paid batch is never reopened. `RecalculateMDR` now subtracts those reversals from its recomputed fee, so it no longer posts a false adjustment on a batch with refunds. Tests added in `batch_test.go` and `recalculate_mdr_test.go`. PR: https://github.com/SilentYsf/fils-pay/pull/50 See the Feature entry "Merchants can refund a payment".
### Bug: KYC PDF-only check trusts the filename, not the file bytes
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A PNG or JPEG renamed to end in .pdf was accepted as a commercial_registration or bank_letter, and a genuine PDF whose filename did not end in .pdf was wrongly rejected.
- **Cause:** `recordKycDocument` in `apps/api/src/onboarding/kyc.ts:67` decided the PDF-only rule from `input.fileName.toLowerCase().endsWith(".pdf")`, the client-supplied filename, although the real magic-byte type was already detected at `:50`. The module validates from the bytes, never the name (`onboarding/fileSignature.ts:1-6`); the in-code comment claiming `detectFileType` already narrows these document types was false.
- **Breaks:** The PDF-only gate for registry and bank documents: a non-PDF disguised with a .pdf name reached review as a PDF, and a real PDF under a different name was refused.
- **Fix:** The check now compares the detected type (`detected !== "pdf"`), the same string-literal shape the rest of the file uses; the `document_must_be_pdf` error is unchanged. The existing test that asserted the filename behaviour was corrected to accept a real PDF regardless of name, and one test was added for a PNG renamed .pdf being rejected. The upload size limit the ticket worried about is already capped at the boundary (`plugins/multipart.ts` fileSize to 413 in `plugins/errorHandler.ts`), so no size change was needed.

### Bug: A fresh deploy cannot build or boot in production mode
- **Status:** Fixed
- **Type:** Deploy, critical
- **Problem:** `docker compose -f ops/docker-compose.yml build` failed immediately: the compose file points every service at `ops/Dockerfile.node` or `ops/Dockerfile.go`, but neither file was in the repo. Even once past the build, the Node services booted in dev mode on the hosted box, because nothing set `NODE_ENV`.
- **Cause:** The two Dockerfiles were never committed (in-tree notes claim they are on `main`, but `ls ops/` shows only the compose file and the README). Separately, the compose file had no `env_file:` directive, so `ops/.env.docker` was never loaded into any container; the comment assuming compose "picks it up automatically" confuses Compose's `.env` substitution file with per-service environment, which it does not inject. With `NODE_ENV` unset, `apps/api` ran as development: OTP codes exposed in responses, the committed dev webhook key in use, and non-secure cookies.
- **Breaks:** The app could not be deployed to Dilmune Cloud at all (build error), and any stack that did come up ran the API in dev mode in front of judges.
- **Fix:** Added `ops/Dockerfile.node` (multi-stage node:20.18 build, node:20.18-slim runtime as the unprivileged `node` user, shared by api, reporting, migrate and seed, each setting its own command) and `ops/Dockerfile.go` (multi-stage go 1.22 build, slim runtime of `apps/settlement` under an unprivileged `app` user). Added `env_file: [.env.docker]` to each build-based service so `NODE_ENV=production` and the secrets load, and ordered api, settlement and reporting after `migrate` with `depends_on: migrate: {condition: service_completed_successfully}` so no service starts against a half-migrated schema. Moved the `seed` job behind a `seed` profile so a bare `up` can no longer truncate and regenerate the data. Bound the published Postgres port to `127.0.0.1` so it is not exposed on a public host. Added a root `.dockerignore` (`node_modules`, `.git`, `**/.env*`) so no env file or secret is baked into an image, added `ops/.env.docker` to `.gitignore`, and documented in `ops/.env.docker.example` and `ops/README.md` every variable the host must set before the first run (the stack crash-loops without `SETTLEMENT_INTERNAL_TOKEN` and `WEBHOOK_SECRET_ENCRYPTION_KEY`). Additive only; no service, schema or DB change.
- **Verified:** `docker compose config` renders `NODE_ENV=production`, the migrate ordering and the loopback Postgres bind. Both images build. Booted the full stack locally against a throwaway Postgres (own volume, removed after): `migrate` ran first as the dependency and exited 0, then api, settlement and reporting all stayed up; `GET /healthz` returned 200 `{"status":"ok"}` and `GET /readyz` returned 200 `{"status":"ready"}`; api ran as `uid=1000(node)` and settlement as the `app` user. On a brand-new database `migrate` still stops on migrations 0054/0055 (BHA-72); the boot above used the documented local skip of those two, so a fresh-DB deploy needs BHA-72 landed first.
### Bug: Payout disbursement is only recorded through webhook delivery
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** A merchant with no active webhook endpoint, or only paused ones, never got a payout disbursement record for a paid batch (BHA-130), and a merchant with several endpoints had the record written by whichever delivery ran first (BHA-140).
- **Cause:** The record was a side effect of a webhook delivery's first attempt (`apps/api/src/webhooks/dispatcher.ts:37-42` and `:160-163` before this change). Deliveries exist only per active endpoint, so no endpoint meant no delivery and no record, while every extra endpoint and replay reached the write again and only BHA-34's lock-and-check kept it to one row.
- **Breaks:** Paid batches of endpoint-less merchants have no disbursement record, so their payouts cannot be traced to a disbursement reference; whether a payout was recorded depended on the merchant's webhook settings instead of the payout.
- **Fix:** Settlement's `enqueuePaidEvent` (`apps/settlement/internal/settlement/payout_notify.go`), which already locks the batch row and inserts the batch's one `settlement.paid` event for both payout paths (`PayoutBatch` and `PayoutSplitBatch`), now inserts the disbursement in the same transaction when that event is new, with `net_payout_fils` read from the locked row; the dispatcher no longer writes it. It lives in notify rather than in pay, where the 0057 migration comment places it, because notify is the one place both pay functions reach; `docs/ARCHITECTURE.md` now says so. Batches paid before this deploy are not backfilled; the one-off SQL is in the PR and waits for a human. PR: https://github.com/SilentYsf/fils-pay/pull/59. Tests added: a Go test for a merchant with no endpoint (0 rows before, 1 after), a disbursement check in the concurrent-pass test, and the dispatcher test now asserts that delivery to two endpoints plus a replay writes no row (1 before, 0 after).
### Bug: A fresh database cannot be migrated, blocking the live deploy
- **Status:** Fixed
- **Type:** Deploy, critical
- **Problem:** Running the migrations against an empty database aborted at `0054_views.sql`, so every migration after it (0055, 0057, 0058, 0060 and the rest) never ran. A new environment, including the hosted deploy, could not be built at all.
- **Cause:** Two migrations reference schema that does not exist. `0054_views.sql` defines `v_unbatched_capture_events` with `NOT EXISTS (SELECT 1 FROM settlement_batch_events ...)`, but no migration ever creates a `settlement_batch_events` table; batching state lives on `transaction_events.settlement_batch_id` (added in 0023, used throughout `apps/settlement`). `0055_chart_of_accounts_suspense.sql` inserts into `chart_of_accounts (code, name, account_type, description)` with `account_type` 'suspense', but the table (0007) is `(id, name, kind)` with `kind` restricted to 'asset','liability','revenue' and has no code, account_type or description column. Both migrations had only ever been hand-marked applied in the local baseline, so neither had run successfully anywhere.
- **Breaks:** No fresh environment could be provisioned. The Friday deploy to Dilmune Cloud starts from an empty database, so it was blocked outright.
- **Fix:** Two parts. First, the two broken files are corrected in place, because a fresh database aborts inside 0054 before any later migration can run, so a forward migration alone can never heal a fresh database: `0054_views.sql` now tests `te.settlement_batch_id IS NULL` (the exact eligibility rule `apps/settlement/internal/settlement/batch.go` and 0023 already use) instead of the missing `settlement_batch_events` join table, and its event filter now reads `event_type IN ('captured', 'partially_captured')` to match that same settlement query rather than `captured` alone; `0055_chart_of_accounts_suspense.sql` now targets the real columns `(id, name, kind)` with `kind` 'asset' (the treatment 0007 gives its one existing suspense account, `scheme_rounding_residue`, per ADR-0002), the descriptive text folded into the name, and `ON CONFLICT (id)`. Second, a new additive migration `0074_recover_views_and_suspense_accounts.sql` repeats the corrected statements with only idempotent forms (`CREATE OR REPLACE VIEW`, `INSERT ... ON CONFLICT (id) DO NOTHING`): it is a no-op on a fresh database (0054/0055 already built the objects identically) and creates the missing three views and two accounts on any database that marked 0054/0055 applied under the old local-baseline workaround, where admin balance rebuild (`merchant_payable_position` in `apps/settlement/internal/ledger/refresh.go`) otherwise fails. On ADR-0005 (which reserves migration numbers 0054 to 0056 for an unmerged settlement v2): the departed developer had already used 0054 and 0055 for these non-v2 migrations, the v2 tables they reserve were never merged, and editing two files that never applied anywhere introduces no new use of those numbers. The new work lands on 0074. Editing applied migrations in place is a schema decision that needs human sign-off (rule 3); flagged for approval. No existing schema was dropped, reset or recreated. Verified by migrating an empty database end to end (all migrations applied, 0054, 0055 and 0074 among them), confirming the three views query and both accounts exist with `kind` 'asset', and that a re-run is idempotent.
### Bug: Split payouts lose or invent a fil every batch
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** A marketplace parent paid out across sub-merchants (the seed's Delta Marketplace, 50/30/20) paid its children a fil more or less than the batch's net payout: a 1003 fils batch paid 1004, a 1001 fils batch paid 1000.
- **Cause:** `PayoutSplitBatch` (`apps/settlement/internal/splits/allocate.go:98`) rounded each child's share on its own with `ApplyRateFils` (half-to-even), so the rounded shares need not add back up to `net_payout_fils`; nothing handed out the leftover or checked that the weights add up to 100%.
- **Breaks:** The parent's payout ledger legs and `settlement_batch_splits` rows disagree with the batch they pay, and its cached payable balance ends a fil off (-1 on the 1003 batch) every time the shares do not round evenly.
- **Fix:** `ChildShares` (`splits/shares.go`) now uses the largest-remainder method, the same rule as `allocateRemainder` in `packages/money`: each child gets the floor of its exact share, and the leftover fils go one each to the largest remainders, ties to the lower `child_merchant_id`. It rejects weight sets that are not positive and do not sum to 10000 bps, so a misconfigured split fails the payout instead of paying the wrong amount. `PayoutSplitBatch` now calls it. Rounding explains at most one or two fils per batch, not the "tens of fils" the finance note mentions. Tests added: exact shares for 1003 and 1001, and a DB test checking the split rows, ledger debits and cached balance all equal the net payout. PR: https://github.com/SilentYsf/fils-pay/pull/54
### Bug: Webhook SSRF guard misses CGNAT, NAT64 and hostnames that resolve inside
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** After the BHA-36 fix, a merchant could still register a webhook endpoint at `https://100.100.100.200/` (a cloud instance-metadata address), at a NAT64 address such as `[64:ff9b::a9fe:a9fe]` (169.254.169.254 through NAT64) or at an IPv4-compatible address such as `[::7f00:1]`, and the dispatcher and test-send would try to connect to it. A hostname that resolves to loopback or a private address (`https://localhost./`) was also accepted at registration and then failed on every delivery.
- **Cause:** The blocklist in `apps/api/src/webhooks/transport.ts:36-50` did not include 100.64.0.0/10, 64:ff9b::/96 or the IPv4-compatible ::/96 block, and `validateWebhookUrl` (`apps/api/src/webhooks/create.ts:16`) only checked IP literals and the exact word `localhost`, without resolving the hostname or normalising a trailing dot.
- **Breaks:** On a host where those ranges route (carrier-grade NAT and metadata on some clouds, IPv6 networks with NAT64), a merchant could make the server POST to internal services and read 2000 characters of the answer through test-send. Merchants could also save an endpoint that could never receive a delivery, with no error.
- **Fix:** Added 100.64.0.0/10, the NAT64 prefixes 64:ff9b::/96 and 64:ff9b:1::/48, and ::/96 (which also covers :: and ::1) to the transport blocklist, and made `validateWebhookUrl` strip a trailing dot and resolve non-IP hostnames with `node:dns`, rejecting any that resolve to a blocked address. The send-time check on the resolved address is unchanged, so DNS rebinding after registration is still blocked, and redirects are still never followed. No new dependency. Tests added. PR: https://github.com/SilentYsf/fils-pay/pull/57

### Bug: Bad input on payment-link and transaction routes crashes with 500 or is silently ignored (BHA-89, BHA-90, BHA-92, BHA-94, BHA-88)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Creating a payment link with amount 0, listing links with `limit=abc` or a crafted cursor, and cancelling a link with a non-UUID id answered 500. A garbage cursor on the transaction list silently returned page one, so a client with a corrupted cursor looped over the first page.
- **Cause:** `routes/paymentLinks.ts` and `routes/transactions.ts` passed raw input down. `toFils` allows 0, so the insert hit the database check; `Number.parseInt("abc")` gave NaN for `LIMIT`; a cursor with a bad date or id reached a `::timestamptz` / uuid cast; `decodeCursor` in the two query modules turns any malformed cursor into `null`, which means page one.
- **Breaks:** Merchants got internal errors instead of a 400 they can act on, and paging through transactions could silently restart.
- **Fix:** Validation at the route boundary in the two route files: amount must be greater than 0, `limit` a positive integer, cursor must decode to a real Postgres timestamp plus a UUID, cancel id must be a UUID; each answers 400 with a fixed error code. `limit=0` used to clamp to 1 and now answers 400. Tests added in `paymentLinks.test.ts` and `transactions.test.ts`, including one that a cursor the API issued still works.
### Bug: The nightly expire_holds janitor deletes every hold on a night with nothing expired
- **Status:** Fixed
- **Type:** Data, critical
- **Problem:** On any night when no hold has expired, the `expire_holds` cron job wipes the entire `holds` table instead of deleting nothing.
- **Cause:** `buildWhere` in `scripts/lib/sqlFilter.ts` did `if (val.length === 0) continue` for an empty array, so an empty id list left `parts` empty and dropped the `WHERE` clause entirely. `buildExpiredHoldsDelete([])` then emitted `DELETE FROM holds` with no `WHERE`, which matches every row. The janitor's own docstring claimed "a night with nothing expired changes no rows", which was false.
- **Breaks:** Every active authorization hold across all merchants could be erased in one unattended cron run, including during judging.
- **Fix:** In `buildWhere`, an empty `in`-list now emits a false predicate (`1 = 0`) instead of dropping the clause, so an empty filter matches zero rows (the SQL-correct meaning of `col IN ()`). This is the shared place all callers route through, and matching nothing is also the right behaviour for a SELECT filter. The janitor docstring now states the real behaviour. Test added (`scripts/expire_holds.empty.test.ts`): `buildExpiredHoldsDelete([])` produces `DELETE FROM holds WHERE 1 = 0`, never a WHERE-less delete.

### Bug: Malformed ids, limits, cursors and dates crash webhook, settlement and reporting routes with a 500
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** A non-numeric `limit`, a crafted `cursor`, a non-UUID endpoint, delivery or batch id, or an invalid date on the settlement list, reconciliation and summary routes answered 500. On `GET /v1/reporting/transactions`, `?from=banana&to=banana` was silently ignored and returned the full dataset, and a bad date inside the `filter` JSON answered 500.
- **Cause:** The routes passed raw input to Postgres or to `bahrainLocalMidnightUtc` (`settlement/query.ts`, which throws RangeError). `Number.parseInt("abc")` gave NaN as a `LIMIT`; a malformed uuid or timestamp failed the cast; `routes/reporting.ts` read only the `filter` JSON and never looked at top-level `from`/`to`.
- **Breaks:** Any client typo or probe produced an internal error instead of a usable message, and a mistyped report date returned unfiltered data that looked valid.
- **Fix:** Routes validate at the boundary with the repo's `UUID_RE`: bad ids give 404, bad limit, dates or filter shape give 400. The two keyset queries turn a Postgres class-22 error on a decoded cursor into 400 `invalid_cursor`. Reporting now validates and honours top-level `from`/`to` (the filter object wins if both are given). Tests added in `webhooks.test.ts`, `settlement.test.ts` and `reporting.test.ts`.
### Feature: Merchants can refund a payment
- **What:** A merchant owner or finance user can refund a captured payment in full or in part, from the dashboard or the API. The customer is paid back by the acquirer, the platform fee is reversed in proportion, the refund comes off the merchant's next payout, and the merchant's webhook endpoints are told.
- **How it works:** `POST /v1/refunds` (PR #61, BHA-31) takes the merchant from the session or API key, requires an `Idempotency-Key`, answers 404 for another merchant's transaction, caps the total at captured minus refunded, and reverses the fee cumulatively so uneven partial refunds never reverse more than was charged. `CloseBatch` (PR #50) subtracts the day's succeeded refunds from the batch and carries a refund larger than the day's sales forward to the next batch. The transaction page has a Refund drawer (PR #69) that parses BHD into integer fils and reuses one key on a retry. `processRefund` enqueues a `refund.succeeded` event, which every active webhook endpoint receives signed (PR #73). The bugs this work exposed are the entries "Refunds pay out twice and can exceed the charge", "Refunds could not be made, and the drafted refund path refunded other merchants' payments and reversed too much fee", "Refunds never come off the merchant's payout" and "The dashboard had no way to refund a payment".
- **How to try:** Capture a payment, open it under Transactions in the merchant app, press Refund, enter an amount and confirm; the page shows the refunded total. Or `POST /v1/refunds` with `transactionId`, an optional `amountFils` and an `Idempotency-Key` header. Register a webhook endpoint first to see `refund.succeeded`; close that day's batch to see the refund taken off the payout.
### Bug: Refunds could not be made, and the drafted refund path refunded other merchants' payments and reversed too much fee
- **Status:** Fixed
- **Type:** Money, critical
- **Problem:** `POST /v1/refunds` answered 501, so no merchant could refund a payment. Wired as drafted, its helpers would have let a merchant refund another merchant's payment. Every refund sent without a reason would also have failed after the acquirer had already paid it out. Three partial refunds of 300, 300 and 400 fils would have reversed 26 fils of a 25 fils fee, and a merchant with a negotiated discount would have had the full fee reversed although part of it was already returned.
- **Cause:** `apps/api/src/routes/refunds.ts:23-25` was a stub. Its drafted handler made a new idempotency key on every call and spread the request body over `merchantId`. `apps/api/src/refunds/initiateMerchantRefund.ts:62-73` looked the transaction up by id only and passed the owner on as the merchant. `apps/api/src/payments/processRefund.ts:162` inserted `reason ?? null`, which migration 0070 rejects. `processRefund.ts:144` rounded each partial refund's fee on its own (`calculateRefundFee`) against the gross MDR credit (`:111-117`), which ignores the discount debit that `discountAdjustment.ts:81` posts.
- **Breaks:** Refunds, the missing feature in the brief (FP-300). Without the fix, refunds could not be made at all. Wired as drafted, a merchant could refund any merchant's payment, the platform would lose fee fils on uneven partial refunds, and discounted merchants would get their discount back twice.
- **Fix:** The route now requires merchant auth and an owner or finance session (API keys pass, as for capture). It takes the merchant from the session or key, never from the body, and requires the client's `Idempotency-Key`; a retry with the same key replays the first answer. It rejects a zero, negative or fractional amount with 422, and a bad `transactionId` or `reason` (not a string, over 500 characters, or containing a NUL) with 400, before anything is claimed. `initiateMerchantRefund` and the locked select in `processRefund` both filter on `merchant_id`, so another merchant's transaction answers 404. A missing reason is stored as `unspecified`. The fee reversal is now cumulative: fee(total refunded after this refund) minus what earlier refunds already reversed, computed on the ledger's net platform fee for the transaction, so the discount is never reversed twice. 300, 300 and 400 fils now reverse 8, 7 and 10, which is exactly 25, and the reversal can never exceed the fee charged. `packages/money` is unchanged, and there is no migration. Tests added. PR: https://github.com/SilentYsf/fils-pay/pull/61 See the Feature entry "Merchants can refund a payment".

### Feature: Merchants get a `refund.succeeded` webhook
- **What:** When a refund succeeds, every active webhook endpoint of the merchant receives a signed `refund.succeeded` event with the refund's amount, the fee reversed and the transaction's new total and status.
- **How it works:** `processRefund` already enqueues a `refund.succeeded` outbox event. `apps/api/src/webhooks/dispatcher.ts` now lists it in `WEBHOOK_ELIGIBLE_EVENT_TYPES`, and `buildEnvelope` in `apps/api/src/webhooks/envelope.ts` maps it field by field, so the outbox cannot stall on an unmapped type. Body `data`: `refundId`, `transactionId`, `merchantId`, `amountFils`, `feeReversedFils`, `refundedTotalFils`, `transactionStatus` (all fils are integers). Disabled endpoints get nothing, and each endpoint gets exactly one delivery per refund. No migration.
- **How to try:** Register a webhook endpoint, then `POST /v1/refunds` on a captured transaction; the endpoint receives the event.
- **Not covered yet:** Reporting does not roll refunds up. `merchant_daily_volume` has no refund columns, and `refund_merchant_summary` (0072) joins `transactions t ON t.id = r.id` (it should be `r.transaction_id`), so it is always empty. Fixing either is a schema change that waits for both humans. BHA-133 stays open for it.
### Bug: The dashboard had no way to refund a payment, and the parked refund form posted to the wrong place
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** A merchant owner or finance user could not refund from the transaction page: there was no Refund button, no refunded amount and no refund error text. The parked form would also have refunded twice on a retry.
- **Cause:** `apps/web/src/pages/transactions/RefundDrawer.tsx` was commented out and imported nowhere. Its draft called `/v1/merchants/:id/refunds`, a route that does not exist, took amounts in fils, and made a new `Idempotency-Key` on every click. The API's refund refusals first answered `{ ok: false, code }` instead of `{ error, message }` (fixed in #61), and `apps/web/src/api/client.ts` read only `error`, so such a failure showed a blank banner.
- **Breaks:** Refunds (the brief's FP-300) were unusable from the UI. Typing 4.75 BHD in a fils box would have refunded 4.75 fils, and a retry after a lost response would have sent a second refund under a new key.
- **Fix:** The drawer now calls `POST /v1/refunds`. It parses BHD with `parseBhdToFils` (3 decimals, integer fils), shows the API error text, and reuses one idempotency key when the same amount is retried after no answer came back. It is hidden from `support` and when nothing is refundable. The detail page shows the refunded total, summed from the refund events the timeline already returns, so there is no new endpoint. The client now reads `code` when `error` is absent. Tests added in `dashboard.test.ts`. The admin `refunds_enabled` toggle was not wired: no admin endpoint writes that column. PR: see this PR. See the Feature entry "Merchants can refund a payment".
### Bug: Settlement daemon only catches up the most recent day
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** When the settlement daemon was down across more than one Bahrain midnight, it only settled the day that had just ended when it came back. The earlier missed days were never closed or paid, so merchants went unpaid for them until an operator backfilled each date by hand. A single merchant whose batch failed also stopped every merchant sorted after it.
- **Cause:** `runIfDue` in `apps/settlement/internal/scheduler/daemon.go:66-84` always ran `RunDailyBatch` for exactly one business date, the one `dueBusinessDate` returns (yesterday in Bahrain time), and the comment above it left older days to a manual `run-batch --date`. `RunDailyBatch` in `apps/settlement/internal/settlement/batch.go:430-475` returned at the first merchant whose close or payout failed.
- **Breaks:** Payouts for every missed day were silently skipped for all merchants, and one bad merchant blocked the payouts of every merchant after it in id order.
- **Fix:** On each wake-up the daemon now lists every (day, merchant) in the last 31 days, up to yesterday, where an active merchant already signed up by that Bahrain day has no paid batch, and runs `RunDailyBatch` for that one merchant and day, oldest day first. A merchant created later gets no batches before its signup day, and a merchant whose batch keeps failing only retries its own days; its failure is logged and the other merchants and days still run. CloseBatch and PayoutBatch are already idempotent, so closed or paid days are no-ops. Days that leave the 31-day window while still unpaid are logged once, as a range, pointing to `run-batch --date` to backfill them. `RunDailyBatch` itself (also used by the CLI and the admin run-batch) now runs its merchants through `runMerchants`, which moves on past a failing merchant and returns every failure joined into one error naming each merchant, and stops early only when its context is cancelled. Tests added: `TestRunIfDue_CatchesUpEveryMissedDay` (injected clock, three missed days, a merchant created after a missed day, a merchant failing on one day) and `TestRunDailyBatch_MerchantErrorDoesNotStopOthers` (failing merchant first, the healthy one still paid, the error names the failing one). PR: https://github.com/SilentYsf/fils-pay/pull/67

### Bug: A payout never reaches the cached balance when the merchant has no balance row
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** Paying out a closed batch for a merchant with no `merchant_balances` row (every merchant in the seeded data: 64 closed, unpaid batches and zero cache rows) left the cache untouched, so the admin console kept showing no cached payable while the ledger had already paid the money out.
- **Cause:** `balances.ApplyPayout` in `apps/settlement/internal/balances/cache.go:41-47` was a bare `UPDATE ... WHERE merchant_id = $1`, which silently matches 0 rows when the row does not exist. Both `PayoutBatch` and `PayoutSplitBatch` route through it, and nothing checked the row count. On the daily path the close runs first, and `ApplyBatchClose` (`cache.go:25-34`) created the missing row from that day's net alone, ignoring every batch already closed and unpaid.
- **Breaks:** The cached balance drifts from the ledger for every merchant whose batches were closed before the cache existed, until someone runs a rebuild. On the daily `run-batch` path it goes negative: closing an empty day creates the row at 0, and paying a 15.000 BD batch then leaves the cache at minus that amount while another 6.000 BD batch is still closed and unpaid.
- **Fix:** Both cache functions in `balances/cache.go` are now one `INSERT ... SELECT ... ON CONFLICT DO UPDATE` in the caller's transaction, with the same rule for a missing row: start from the net of the merchant's closed, unpaid batches. An existing row still moves by the delta as before. `ApplyBatchClose` counts the batch being closed once, through the sum, because `CloseBatch` has already marked it closed. `ApplyPayout` leaves out the batch being paid, because `PayoutSplitBatch` marks it paid only after the cache update. A plain upsert of the delta was rejected because it ignores the batches the cache never saw. Seeding from the ledger was rejected because the ledger already holds captures that are not closed yet, so their close would add them a second time (ADR-0007 records the same double count for the rebuild). Three tests were added, each failing without the fix. The payout test checks the cache is 0 after the payout and equals the ledger after the next close. The close-first test closes an empty day and then pays a batch, and checks the cache equals the closed, unpaid total. The split-parent test pins the paid batch's exclusion.
### Bug: Concurrent retries of a failed idempotency key both move money (BHA-146)
- **Status:** Fixed
- **Type:** Concurrency, high
- **Problem:** Two retries of the same request fired at once, after an earlier attempt left the idempotency key in `failed`, both run the capture, refund or authorize money operation, so the money moves twice.
- **Cause:** In `apps/api/src/payments/idempotency.ts`, the read of the existing `failed` row took no row lock and the UPDATE back to `in_progress` matched on `id` alone. Under READ COMMITTED both retries read `failed` before either updated, so both passed the guard and both executed; the UPDATE could even overwrite a claim another retry had already marked `completed`.
- **Breaks:** A client retry during a failed attempt could capture, refund or authorize the same amount twice, over-charging or over-crediting with no sign it ran twice.
- **Fix:** The existing-row read now takes `FOR UPDATE`. The second retry blocks on the row lock until the first retry's transaction commits, then reads the committed status: `completed` replays the stored result, `failed` means it is the single retry that proceeds. One row lock, no check-then-act (ADR-0002). This is the shared claim path every money endpoint routes through. Concurrency test added (`idempotencyClaim.test.ts`): two parallel retries of a failed key leave exactly one proceeding and the other replaying.

### Bug: Capture discount credited twice on a zero-rebate replay (BHA-145)
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** For a merchant with a negotiated discount, once any capture's rebate rounded down to zero fils, replaying a later successful capture credited that later capture's discount to the merchant a second time.
- **Cause:** `applyCaptureDiscountAdjustment` in `apps/api/src/payments/discountAdjustment.ts` guarded against double-posting by comparing the count of adjustment ledger credits to the count of capture events, assuming one adjustment per capture. A capture whose rebate rounds to zero writes no ledger row (`ledger_entries` has `CHECK (amount_fils > 0)`), so the adjustment tally stayed permanently below the capture-event tally and the guard never tripped; a replay of a later, non-zero capture then posted its discount again.
- **Breaks:** Merchant payable rose above the ledger's truth by the discount share of a fee per affected transaction, and settlement pays it out.
- **Fix:** The guard now counts only the capture events whose rebate actually rounds above zero, computed with the same `applyRateFils` rounding used to post, and compares that to the adjustments already posted. A zero-rebate capture no longer leaves the guard short, so each capture's discount posts exactly once regardless of rounding. Integer fils throughout (ADR-0001). Regression test added in `discountAdjustment.test.ts`: a zero-rebate capture followed by a non-zero one, replayed, credits once.
### Bug: Reconciliation prices pending captures with float math (BHA-107)
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** `GET /v1/settlement/reconciliation` reports a spurious non-zero gap (`explained: false`) on correctly settled books whenever a pending (unbatched) capture rounds differently under float than under the integer fee math the capture actually used. A 20-fil capture at 250 bps is a clean example: the gap comes out as 1 fil.
- **Cause:** `fees/estimate.ts` priced the pending fee with JS float basis points (`amountFils * mdrBps / 10_000`, then `Math.round`), violating ADR-0001's integer half-to-even rule and disagreeing with `applyRateFils`, the primitive `payments/capture.ts` charges the real fee with. 20 x 250 / 10000 is exactly 0.5 fil: banker's rounding (and so the ledger) gives 0, the old `Math.round` gave 1.
- **Breaks:** Finance sees a reconciliation that does not explain to zero on books that are in fact correct, eroding trust in the one report meant to prove the ledger and the settlement agree.
- **Fix:** `estimateFeeFils` now prices through the same integer `applyRateFils` path as capture (gross fee, then the discount reversal, each banker's-rounded independently), so no float ever touches a money value. `settlement/query.ts` feeds it the resolved rate. Test added: an unbatched 20-fil capture now reconciles to a zero gap.

### Bug: Reconciliation ignores the tier bonus and dated fee schedules (BHA-108)
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** `GET /v1/settlement/reconciliation` prices pending captures off the merchant's flat current `mdr_bps` and `negotiated_discount_bps`, so a merchant on a dated fee schedule or the volume tier shows a false reconciliation gap even though every capture was priced correctly.
- **Cause:** `settlement/query.ts` read `merchants.mdr_bps` directly, trusting a comment that a `0046` trigger keeps it in sync with `fee_schedules`. No such trigger exists, and even if it did the column holds only the current rate, not the rate in force when each past capture was taken. The capture path (`capture.ts`) instead resolves the effective-dated schedule (`getEffectiveMdrBps`) net of the platform volume-tier bonus (`getVolumeTierBonusBps`).
- **Breaks:** Any merchant whose rate changed over time, or who crossed the platform volume tier, reconciles with a gap that is pure artefact, hiding a real gap if one ever appeared.
- **Fix:** `settlement/query.ts` now loads the merchant's fee-schedule history once and resolves each pending capture's rate at its own `occurred_at` (new `loadFeeSchedule` + pure `resolveMdrBps` in `fees/feeSchedule.ts`, same point-in-time rule `getEffectiveMdrBps` runs in SQL), subtracts the volume-tier bonus, and prices through the integer path, matching CloseBatch and the ledger. Test added: a capture on a merchant with a dated 180 bps schedule and a negotiated discount reconciles to a zero gap.
### Bug: Acquirer callback stores an unvalidated outcome string
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** A signed acquirer fraud-review callback could store any string as its `outcome` (for example `totally_made_up`), which then shows on the transaction timeline that support and finance read.
- **Cause:** `routes/acquirerCallbacks.ts` checked only that `outcome` was present, then cast `body.outcome as AcquirerCallbackInput["outcome"]` and inserted it; migration 0051 defines `outcome TEXT NOT NULL` with no CHECK, so the enum was never validated. Two comments claimed otherwise and were both false: the route comment said `outcome` was "validated against the AcquirerCallbackInput union ("approved" | "rejected")", which even named the wrong values (the real union is `cleared | confirmed_fraud`), and the input-type comment said it was "validated against the two allowed values by the route schema". There was no such validation and no schema.
- **Breaks:** Arbitrary outcome values enter the data and surface in the UI, so support and finance can read a fraud verdict the acquirer never sent.
- **Fix:** Added one source of truth for the allowed outcomes (`ACQUIRER_CALLBACK_OUTCOMES = ["cleared", "confirmed_fraud"]`) in `acquirer/callbacks.ts`, and a type-guard check at the route boundary that rejects any other value with a clean 400 before the callback is stored. Removed the unsafe `as` cast and corrected both false comments. Test added: an unknown outcome returns 400 and writes no note. A DB CHECK on the column is a reasonable defence-in-depth follow-up, but it is a schema change that needs human approval, so it is not in this PR.

### Bug: Acquirer callback crashes on an invalid occurredAt
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** A signed acquirer callback whose `occurredAt` is not a real date (for example `not-a-real-date`) failed its insert, was retried three times, then returned a 500.
- **Cause:** `routes/acquirerCallbacks.ts` checked only that `occurredAt` was present, never that it was a date, so a non-date reached the `received_at TIMESTAMPTZ` column and the insert threw; `withCallbackRetry` burned three attempts before surfacing a 500.
- **Breaks:** Bad callback input wastes retries and returns a server error instead of a clear rejection the acquirer can act on.
- **Fix:** Added a boundary check (`Number.isNaN(Date.parse(occurredAt))`, the same shape `routes/analytics.ts` already uses) that rejects a non-date with a clean 400 before any DB work or retry. Test added: a malformed occurredAt returns 400 and writes no note.
### Bug: Reporting saved-filters has no creation quota and no bounded listing
- **Status:** Fixed
- **Type:** Performance, medium
- **Problem:** A merchant could create saved filters without limit, and `GET /v1/reporting/saved-filters` returned every stored row in one response, so the listing grew without bound.
- **Cause:** `createSavedFilter` inserted unconditionally with no per-merchant cap, and `listSavedFilters` ran a `SELECT ... ORDER BY created_at DESC` with no `LIMIT`. A code comment claimed a CHECK in the 0061 migration capped a merchant at 50 filters; that claim is false (migration 0061 is chart-of-accounts, and 0069 creates the table with no such CHECK).
- **Breaks:** One merchant can accumulate saved filters indefinitely and every list call returns all of them, a response that grows without limit.
- **Fix:** `createSavedFilter` now writes the row inside a single INSERT guarded by a count subquery (`... SELECT ... WHERE (SELECT count(*) ...) < $4`), which bounds a merchant to about 100 filters; at the cap it writes nothing and throws a 409 `saved_filter_quota_exceeded` (under READ COMMITTED two racing creates can overshoot by one or two, which is fine for a quota that only needs to bound growth). `listSavedFilters` clamps a `LIMIT` to the house range (default 25, max 100), matching the other list queries, and the `GET /v1/reporting/saved-filters` route reads and passes through an optional `?limit`. The false comment claiming a 0061 CHECK cap is removed. Tests added, including a route test that asserts `?limit` is honoured.

### Bug: Analytics date validator accepts impossible dates and 500s
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** `GET /v1/analytics/*` accepted an impossible but correctly-shaped date such as 2026-02-30 or 2026-04-31 and then answered 500.
- **Cause:** `isValidDateString` in `routes/analytics.ts` relied on `Date.parse`, which silently normalizes 2026-02-30 to 2026-03-02 instead of rejecting it, so the impossible date passed the check and reached Postgres, which errored.
- **Breaks:** A malformed date returned a 500 instead of a clean 400.
- **Fix:** `isValidDateString` now builds a UTC date from the parsed year/month/day and requires each component to round-trip unchanged, so a day that does not exist is rejected at the boundary with a 400 `invalid_date`. Test added.

### Not a bug: Reporting transactions already rejects filter=null
- **Type:** UX
- **Claim:** BHA-165 reported that `GET /v1/reporting/transactions?filter=null` 500s because the parsed JSON null is dereferenced as a filter object.
- **Checked:** On `origin/main` the route already guards a parsed null, non-object or array filter and answers 400 `invalid_filter` (`routes/reporting.ts`), and `routes/reporting.test.ts` already asserts `filter=null` returns 400. The guard landed with BHA-91.
- **Why it is not a bug:** The reported 500 no longer reproduces on the current base; the per-route validation BHA-165 asked for is already present and tested, so no change is needed.
### Bug: Client request errors are reported as 500 on every JSON route
- **Status:** Fixed
- **Type:** UX, high
- **Problem:** A malformed JSON body, an unsupported `Content-Type`, or a body over the size limit answered `500 {"error":"internal_error"}` on every route, so a client's own bad request looked like a server crash. This is the shared root cause behind the per-route "bad input gives 500" findings.
- **Cause:** The shared error handler in `apps/api/src/plugins/errorHandler.ts` mapped Fastify's request-parsing errors (`FST_ERR_CTP_INVALID_JSON_BODY`, `FST_ERR_CTP_INVALID_MEDIA_TYPE`, `FST_ERR_CTP_BODY_TOO_LARGE` and the like) to the catch-all 500 branch. Those errors already carry the correct 4xx `statusCode`, but the handler never read it.
- **Breaks:** Integrators could not tell a request they could fix from a server fault, and every monitoring 500 hid a plain client mistake.
- **Fix:** In the shared handler, a Fastify framework error (`FST_` code) carrying a 4xx `statusCode` now answers that status with a clean machine-readable code (`unsupported_media_type`, `payload_too_large`, else `bad_request`) and Fastify's own static message. Genuine server faults, including the handful of `FST_` codes that are 5xx, still answer 500 with no stack trace, SQL or internals. One route is unchanged; the one shared place every route routes through now classifies client errors correctly. Test added (`plugins/errorHandler.test.ts`): a malformed JSON body returns 400 and an unsupported content type returns 415, neither leaking internals.
### Bug: Login crashes on a non-UUID merchant id (BHA-75)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** POST /v1/auth/login with a merchantId that is not UUID-shaped answered 500 instead of a clean 4xx, on an unauthenticated endpoint.
- **Cause:** `routes/auth.ts` passed `merchantId` straight into the login query, where `merchant_id` is a uuid column; a non-uuid value raised Postgres 22P02 (invalid_text_representation), which surfaced as a 500.
- **Breaks:** An unauthenticated endpoint leaked a server error and could not tell bad input from a real failure; every malformed login probe produced an internal error.
- **Fix:** Validate `merchantId` against the repo's shared `UUID_RE` at the route boundary, right after the required-fields check, and answer 400 `invalid_request` before the query, the same shape BHA-91 used for the other id routes. The generic `invalid_credentials` path for a well-formed but unknown merchant is unchanged, so nothing new is disclosed. Test added in `app.test.ts`.

### Bug: Listing API keys has no row limit (BHA-78)
- **Status:** Fixed
- **Type:** Performance, low
- **Problem:** GET /v1/merchants/:merchantId/api-keys ran a SELECT with no LIMIT, so the response grew without bound as a merchant's key count grew.
- **Cause:** `listApiKeys` in `apps/api/src/apiKeys/issue.ts` selected every row for the merchant ordered by created_at, with no LIMIT and no way for the caller to cap the page.
- **Breaks:** A merchant with many keys loaded an arbitrarily large response in a single call.
- **Fix:** `listApiKeys` now clamps a page size the same way every other list query in the repo does (`Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT))`, default 25, max 100) and adds `LIMIT $2`; the route accepts an optional `?limit=` and rejects a non-numeric value with 400, matching BHA-91. The query already selected only the display columns, never key_hash. Test added in `app.test.ts`.
### Bug: Authorize, API key delete and business profile routes crash with 500 on bad input, and profile update builds SQL from request keys (BHA-79, BHA-77, BHA-99, BHA-100, BHA-101)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Authorizing with a negative, fractional, NaN or string amount answered 500, and an amount of 0 went through to the acquirer. Deleting an API key with a non-UUID id, signing up with an unknown business type, and updating the business profile with a null, wrongly typed field or a three-letter country all answered 500. A profile update with an unknown key also answered 500.
- **Cause:** `routes/transactions.ts` passed `amountFils` to `toFils`, which throws RangeError on bad numbers and allows 0. `routes/apiKeys.ts` sent any id to a `uuid` comparison. `routes/businessProfile.ts` checked only that signup fields were present, so the database CHECK, NOT NULL and CHAR(2) constraints failed. `updateBusinessProfile` looked up each request key in `PATCHABLE_COLUMNS` and put the result into the `SET` clause, so an unknown key produced broken SQL instead of being refused.
- **Breaks:** Merchants got internal errors instead of an answer they can act on, a zero-amount authorization could reach the acquirer, and the update query's shape depended on the request body.
- **Fix:** Authorize checks the amount is a positive safe integer before any acquirer call (400 `invalid_amount`). Revoke answers 404 `api_key_not_found` for a non-UUID id, using the repo's `UUID_RE`. `assertValidBusinessProfile` in `onboarding/businessProfile.ts` is shared by signup and update: keys outside `PATCHABLE_COLUMNS` give 400 `unknown_field`, bad values give 400 `invalid_business_profile`, and no input is echoed. Signup now also requires an uppercase two-letter country, and treats a null country as omitted. Tests added in `app.test.ts` and `transactions.test.ts`, including that the acquirer is never called.
### Bug: The transaction date filter and the Run batch default use the UTC day, not the Bahrain business day (BHA-139, BHA-142)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Filtering the merchant transaction list to one day dropped that day's payments made between 00:00 and 03:00 Bahrain time and showed the previous day's 00:00 to 03:00 instead. Between 00:00 and 03:00 Bahrain time the admin Run batch form defaulted to the day before yesterday.
- **Cause:** `dayStartIso` in `apps/web/src/format.ts:35` turned the picked date into UTC midnight (`T00:00:00.000Z`), and a comment above it falsely said it had been switched to Bahrain time. `yesterdayIso` in `apps/admin/src/pages/settlement/SettlementPage.tsx:19` subtracted a day in the browser's zone and then read the date in UTC with `toISOString()`. ADR-0003 keys every daily window on the Asia/Bahrain business day, which starts at 21:00 UTC.
- **Breaks:** A merchant checking one day's payments against that day's settlement batch got a list three hours off, so the two never matched. Near midnight the admin could close the wrong day's batch by accepting the default.
- **Fix:** `dayStartIso` now parses the date at `+03:00`, the same parse apps/api's `bahrainLocalMidnightUtc` uses. The Run batch default moved to `apps/admin/src/pages/settlement/businessDate.ts` and takes yesterday from the Bahrain calendar date, the same technique as apps/api's `todayBahrainDateString`, whatever the browser's zone. The web test that asserted UTC midnight now asserts 21:00Z on the previous day. A new admin test pins both sides of 21:00Z with a fixed clock, and admin gained the same `tsx --test` script the web app has. On a local run, the 27 Aug filter now includes a payment made at 01:03 Bahrain time (22:03Z on 26 Aug) that the old filter left out.
### Bug: Settlement can close a business day before it ends, and that day's later captures are never paid (BHA-148)
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Running the batch for today (or a future date) from the admin Run batch form, the `run-batch` CLI or the internal endpoint closed and paid that day straight away. Captures made later the same day were never settled: every rerun answered "already closed".
- **Cause:** `CloseBatch` in `apps/settlement/internal/settlement/batch.go:60` closed any date it was given and never checked that the Asia/Bahrain business day was over. Only the daemon picks a finished day (`internal/scheduler/daemon.go:106`); the CLI (`cmd/settlement/main.go:104`), the internal endpoint (`internal/internalapi/server.go:222`) and the admin route behind it (`apps/api/src/routes/admin.ts:118`) accept any date. Once the batch is closed, a later capture of that day falls outside every other day's window (`BusinessDayWindow`), so no batch ever picks it up.
- **Breaks:** Merchants are permanently underpaid by every capture made after an early close, while the ledger still says the money is owed.
- **Fix:** `CloseBatch` now returns `ErrBusinessDayNotOver` when the day's Bahrain midnight has not passed, before it opens a transaction or creates a batch row, so all three callers are covered in one place. The clock is a package variable so the test can fix it. https://github.com/SilentYsf/fils-pay/pull/75
- **Test added:** `TestCloseBatch_RefusesBusinessDayThatHasNotEnded` in `batch_test.go` fixes the clock at 10:00 Bahrain time and checks that today and tomorrow are refused with no batch row and no event claimed, that yesterday still closes, and that today closes with its capture once Bahrain midnight passes. It fails without the guard.

### Bug: The night the platform crosses the volume tier, settlement pays merchants more than the ledger owes them (BHA-147)
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** When the platform's lifetime volume crossed the 2,000,000 BD tier between a capture and its batch close, the batch charged 15 bps less fee than the capture had journaled. The merchant's net payout came out larger than the `merchant_payable` the ledger held for those captures (300 fils over on 200 BD of captures at 250 bps in the test).
- **Cause:** Capture journals its fee with the tier read at capture time (`apps/api/src/payments/capture.ts:171,199`) and stores it in `transaction_events.metadata.feeFils` (`:261`). `CloseBatch` ignored that and read the tier again at close (`apps/settlement/internal/settlement/batch.go:148-153`), then charged every event at the new rate (`:220-224`). An earlier merchant's close in the same nightly pass can push the counter over the threshold (`:237`), so every later batch that night is priced lower than its ledger.
- **Breaks:** `PayoutBatch` pays the difference out of platform cash, above the recorded liability, once per threshold crossing, and the paid batch no longer reconciles with the ledger.
- **Fix:** `CloseBatch` now charges each capture the fee journaled at capture (`metadata.feeFils`). It then subtracts the negotiated-discount rebates `discountAdjustment.ts` actually credited on each transaction that business day, summed from the ledger in one query per batch, instead of recomputing them. A rebate that never posted (a failed adjustment call, a seeded capture whose fee is already net of the discount) or a discount rate changed since capture can no longer make the payout differ from `merchant_payable`. Events with no journaled fee, or a value that is not a whole number of fils, keep the old computation. https://github.com/SilentYsf/fils-pay/pull/91
- **Test added:** `TestCloseBatch_PaysTheFeeJournaledAtCapture` in `batch_test.go` journals a full capture and a two-part capture at 250 bps, moves `platform_stats` to the threshold, closes the day, and checks the net payout equals the ledger's `merchant_payable`: with no discount, with a discount rebated after capture, and with a discount already folded into the journaled fee as the seed writes it, and with a two-part capture whose first rebate never posted. Without the fix it overpays by 300 fils (no discount) and 263 fils (rebated discount).
### Bug: Settlement never pays out manual merchant credits (BHA-149)
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** A goodwill, dispute or correction credit that an admin posted to a merchant showed up in the merchant's balance, but no payout ever included it. The merchant never received the money.
- **Cause:** `postCreditToLedger` in `apps/api/src/admin/credits.ts:154-190` journals the credit onto `merchant_payable` and adds it to the balance cache. A batch payout is the only thing that ever pays `merchant_payable` out, and it pays `net_payout_fils`, which `CloseBatch` in `apps/settlement/internal/settlement/batch.go:160-170` built from capture events alone (`event_type IN ('captured','partially_captured')`). Nothing in settlement read the credits.
- **Breaks:** Every posted credit stayed owed on the ledger forever, so merchants were underpaid by the full credit amount and their dashboard balance never came back to zero.
- **Fix:** `CloseBatch` now claims the merchant's posted credits that were posted before the end of its business day and are not yet paid, adds them to the batch's gross with no fee (so net = gross - fee still holds, and `RecalculateMDR` keeps them), and stamps each credit's `merchant_payable` ledger legs with the batch id under `FOR UPDATE` in the same transaction, the same claim capture events get. No schema change: `ledger_entries.settlement_batch_id` already existed. A rerun is a no-op and a later batch skips stamped legs, so each credit is paid exactly once; a credit that missed its own day's close is picked up by the next one. Split parents pay it out through their children like the rest of their net. The platform volume tier still counts card captures only, and the balance cache adds only the captures' net at close because the credit entered it when it posted. One thing to know: a batch's `gross_fils` now includes the credits it pays. https://github.com/SilentYsf/fils-pay/pull/90
- **Test added:** `TestCloseBatch_PaysPostedManualCreditsExactlyOnce` in `batch_test.go` posts a backdated credit, a credit with an MDR reversal and a credit posted after the day ended, then checks the day's payout carries the first two, a rerun pays nothing new, the next day pays only the late one, a third day pays 0, and the balance cache and the `merchant_payable` ledger both end at 0. It fails without the fix (the payout is short by 2218 fils).
### Bug: Refunds have no unique reference, so a retry under a new key double-posts (BHA-123)
- **Status:** Found
- **Type:** Money, medium
- **Problem:** The same logical refund sent again under a new `Idempotency-Key` (a client that lost its key, or a re-import) creates a second refund row and reverses the fee a second time, so the money moves twice. The same refund retried under the same key, or two refunds sent at once, are safe.
- **Cause:** Refunds carry no reference that tells a repeat from a second, valid partial refund. The acquirer simulator (`apps/api/src/acquirer/simulator.ts`) echoes the transaction's authorization reference, so every refund of one transaction shares one `acquirer_reference`, and `0042_refunds.sql` leaves that column without a UNIQUE constraint. `processRefund` (`apps/api/src/payments/processRefund.ts`) therefore has nothing to match a repeat against.
- **Breaks:** A client that resends a refund under a fresh key pays the merchant's customer twice, up to the captured amount, and reverses the platform fee twice.
- **Fix:** None stands. PR #70 added a per-refund `acqr_<uuid>` reference and a `UNIQUE (acquirer_reference)` migration (0075), and this entry first said Fixed. PR #97 reverted all of it: partial refunds of one transaction legitimately share an authorization reference, so the constraint cannot hold for valid data, and migrate stopped at 0075 on any database that held a partial refund. A fresh-key retry also got a fresh `acqr_<uuid>`, so it never hit the constraint. What stands on `main` is narrower: `processRefund` claims the client's idempotency key first, so the same key replays the first answer (#61, with the stable acquirer key from #104 covering a retry after a database rollback); the `FOR UPDATE` row lock serialises concurrent refunds (see "Refunds pay out twice and can exceed the charge"); and the cap of captured minus refunded, backed by the `refunded_fils <= captured_fils` CHECK from migration 0079, bounds any double post. A second refund under a new key within that cap is still accepted, because it cannot be told from a legitimate partial refund without a client-supplied reference. Closing that needs a schema or API change and waits for a human.
### Bug: The webhook dispatcher double-delivers when more than one replica runs (BHA-135)
- **Status:** Fixed
- **Type:** Concurrency, high
- **Problem:** With more than one api replica running the in-process webhook dispatcher, both replicas selected the same due delivery and both POSTed it, so the merchant received each webhook twice.
- **Cause:** Step B's due-delivery SELECT in `webhooks/dispatcher.ts` (`attemptDueDeliveries`) picked every `pending` row whose `next_attempt_at` had passed with no atomic claim, and the HTTP send happens outside any transaction. Two passes read the same row before either marked it, so both sent. The comments above it ("only ever run ONE api replica", "staging ran 2 replicas, never saw a dup, so it's fine") asserted safety the code never had.
- **Breaks:** Receivers got duplicate `transaction.captured`, `transaction.voided` and `settlement.paid` deliveries, and the `settlement.paid` pre-delivery effect (payout disbursement) could run twice.
- **Fix:** Each delivery is now claimed before it is sent, with a conditional UPDATE that leases the row by pushing `next_attempt_at` past the send window. The row lock serialises two replicas, so exactly one wins each row and the rest skip it. No schema change: the status CHECK constraint has no `sending` value, and `next_attempt_at` already means "not eligible until". A normal attempt still overwrites `next_attempt_at` with the real backoff or sets a terminal status, so the lease only covers the crash-recovery window. Test added: two overlapping dispatch passes deliver one due event exactly once.
### Bug: Transaction authorize crashes with a 500 on an empty or malformed card object (BHA-80)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** Authorizing with `card: {}`, a missing field, or a wrongly typed field answered 500 instead of a clean 400. BHA-79 already guarded the amount; the card shape was still unchecked.
- **Cause:** `routes/transactions.ts` only checked that `card` was present (`!card`), so an empty object passed. `authorizeTransaction` then handed it to the simulator, where `magicOutcomeForPan(req.card.pan)` called `pan.endsWith(...)` on `undefined` and threw a TypeError, surfacing as an unhandled 500.
- **Breaks:** Malformed card input produced a server error instead of an actionable 400, on both the authorize endpoint and the public payment-link pay flow (the two callers that route through `authorizeTransaction`).
- **Fix:** `authorizeTransaction` validates the card shape at the acquirer boundary before any dereference, idempotency claim or DB transaction: a missing or wrong-typed `pan`, `expiryMonth`, `expiryYear` or `cvv` gives 400 `invalid_request`, matching the house validation style. The response carries only the error code and message, no stack, SQL or internals. Test added in `transactions.test.ts`: seven malformed cards each answer 400 and the acquirer is never called.
### Bug: Balance adjustment with an oversized amount answers 500
- **Status:** Fixed
- **Type:** Data, low
- **Problem:** Sending `deltaFils` above 9007199254740991 (for example the raw JSON number 9007199254740993) to Adjust balance answered 500 instead of a 400 telling the admin the amount is invalid.
- **Cause:** `parseBalanceAdjustmentBody` in `apps/api/src/routes/adminBalanceAdjustments.ts:29` only checked `Number.isInteger`, which is true for unsafe integers. `toFils` on the next lines then threw a `RangeError`, and nothing turned that into a client error.
- **Breaks:** A bad amount from the admin form or an API client looked like a server failure and filled the error log. No balance changed.
- **Fix:** The check now uses `Number.isSafeInteger`, the same test the credit-request and transaction-capture amount checks use, so the route's existing 400 `invalid_request` answers. Test added in `adminBalanceAdjustments.test.ts` that posts the raw JSON text for both signs.
### Bug: A NUL byte in a webhook receiver's response stops its delivery from ever being recorded (BHA-152)
- **Status:** Fixed
- **Type:** Concurrency, medium
- **Problem:** A receiver that answered with a body containing a NUL character (any status code) made its delivery retry on every dispatcher pass forever: the attempt count and status never changed, so the delivery never reached `exhausted`, and the webhook log showed no attempt.
- **Cause:** `attemptOneDelivery` (`apps/api/src/webhooks/dispatcher.ts:180`) passed the raw receiver body into `response_body_excerpt`, and Postgres TEXT rejects NUL. The query threw before the UPDATE applied, and the per-row catch in `attemptDueDeliveries` leaves the row untouched.
- **Breaks:** A receiver controls whether its own delivery ever progresses or backs off, and it adds a failing query to every pass, with an error log line each time.
- **Fix:** One `replaceAll` strips NUL from the body before the three UPDATEs that share it; the 2000-character cap is unchanged. PR: https://github.com/SilentYsf/fils-pay/pull/72. Tests added in `dispatcher.test.ts` for a 200 and a 500 response, which also check that another endpoint is still delivered.

### Bug: Admin audit rows for settlement re-run, balance rebuild and MDR recalculation say "succeeded" before the action has run (BHA-153)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** The audit log showed `outcome = succeeded` for an admin action whose outcome was not known yet. If the API crashed or restarted during the call, or the follow-up update failed, the row stayed `succeeded` for an action that may never have finished.
- **Cause:** The three cross-process routes in `apps/api/src/routes/admin.ts` (`/settlement/run-batch`, `/balances/rebuild`, `/merchants/:id/mdr-recalculation`) commit their audit row before the HTTP call and left `outcome` at the column default `succeeded`; `insertAdminAuditLog` (`apps/api/src/adminAudit/log.ts:83`) applies that default.
- **Breaks:** The audit trail could claim money-moving admin actions succeeded when they did not.
- **Fix:** These three inserts now pass `outcome: "failed"`, and the existing `markAdminAuditOutcome` call sets `succeeded` only after the call returns. No migration. A `failed` row without an `error` field means the outcome is unknown (still running or the process died). Single-transaction callers are unchanged: their row rolls back with the action. Test added in `admin.test.ts` that reads the row from inside the stubbed call for all three routes.
### Bug: Admin settlement errors leak the internal service body
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** When the settlement service failed, the admin API returned its raw response body in the error message, for example `pq: relation "x" does not exist SELECT ...`.
- **Cause:** `callSettlementInternal` (`apps/api/src/admin/settlementClient.ts:133`) copied the first 500 characters of the non-2xx body into the `AppError` message, and all admin settlement calls route through it.
- **Breaks:** Table names, SQL and driver text from an internal service reached the admin browser.
- **Fix:** The body is now logged server-side only. The message keeps the path and status, plus Go's own `{"error":"<code>"}` code when the body is exactly that shape, so the admin UI still shows validation codes. Test added in `settlementClient.test.ts`. PR: https://github.com/SilentYsf/fils-pay/pull/76.

### Bug: CSV balance import reads a thousands comma as a column break (BHA-58)
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** The row `m1,1,250.500,fix` in the adjustment import posted 1 BD with the reason "250.500" instead of failing, so a finance user who typed 1,250.500 moved the wrong amount.
- **Cause:** `parseAdjustmentCsv` (`apps/api/src/admin/adjustmentCsvParsing.ts`) split every line on each comma with no quote handling and never compared the row's column count to the header, so the extra cell silently became the reason.
- **Breaks:** A mis-typed or spreadsheet-exported amount posted a different balance adjustment with no error.
- **Fix:** The splitter now honours double quotes, and a row with more columns than the header is rejected with a 400 `invalid_csv_row` naming the row, before anything is posted. Rows with the optional reason left off still import. A row like `m1,1,250.500` (no reason column) is still three cells, so it is not caught. A thousands comma is rejected either way (unquoted by the column check, quoted by the amount parser with `invalid_amount`); amounts must be written without separators (`1250.500`). PR: https://github.com/SilentYsf/fils-pay/pull/79. Tests added in `adjustmentCsvParsing.test.ts`.
### Bug: Merchant login cookie expires after 10 minutes even though the session lasts 12 hours
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** After a merchant passed the OTP step, the browser dropped the session cookie about 10 minutes after login, so the merchant was logged out long before the session's 12 hours.
- **Cause:** `POST /v1/auth/login` sets the cookie with the pending maxAge (10 minutes), and `/otp/verify` (`apps/api/src/routes/auth.ts:199`) promoted the session on the server but never re-issued the cookie. The admin verify (`adminAuth.ts:217`) already does.
- **Breaks:** Merchants were signed out mid-work, and the server-side session TTL setting had no effect on how long a login really lasted.
- **Fix:** `/otp/verify` now re-sets the same cookie with `sessionTtlHours * 3600` after a successful verify, mirroring the admin flow. Test added in `routes/auth.test.ts`. PR: https://github.com/SilentYsf/fils-pay/pull/81.

### Bug: A KYC document with an Arabic filename cannot be downloaded (BHA-64)
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** Opening or downloading an uploaded KYC document whose filename has non-Latin-1 characters, such as `سجل.pdf`, answered 500.
- **Cause:** `apps/api/src/routes/kyc.ts:100` (and the thumbnail route at `:117`) put the stored client filename straight into `Content-Disposition`. Node refuses non-Latin-1 characters in a header value (`ERR_INVALID_CHAR`).
- **Breaks:** Any merchant or reviewer with a non-English filename lost the document. The same bare name also let a quote or CRLF in a stored name reach the header.
- **Fix:** One `contentDisposition()` helper used by both routes sends `inline; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>`. Non-ASCII, quotes, backslashes and control characters become `_` in the fallback. Tests added in `app.test.ts` for an Arabic name, a quote and CRLF name, and a plain ASCII name.
### Bug: Admin adjustment import history cannot page past the newest 25
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** The "Past imports" table on Import adjustments showed only the 25 newest imports. Older imports could not be reached from the page.
- **Cause:** `loadHistory` in `apps/admin/src/pages/adjustments/AdjustmentImportPage.tsx` kept `page.items` and dropped the API's `nextCursor`, so the page never asked for a second page although `GET /v1/admin/adjustment-imports` returns the cursor and accepts it.
- **Breaks:** Finance could not open the per-row detail of any import beyond the 25 most recent, which is the page's audit purpose.
- **Fix:** The page keeps `nextCursor`, shows a "Load more" button while one exists and appends the next page, the same way `CreditsPage` does. A small `appendImports` helper skips ids already shown. Test added in `appendImports.test.ts`.
### Bug: An expired payment link with a stale reservation tells the buyer to retry
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** Paying an expired payment link whose reservation was never cleaned up answered `409 payment_link_processing`, which the checkout reads as "a payment is in flight, try again", instead of reporting the link as expired. The buyer keeps retrying a link that can never be paid.
- **Cause:** In `apps/api/src/paymentLinks/pay.ts`, `classifyClaimFailure` gated its expiry check on `row.status === "active"`. A link that expired while still stored as `reserved` (its hold not swept) skipped that check and fell through to the `reserved` branch, which returns `payment_link_processing`.
- **Breaks:** Expired links that hold a stale reservation give buyers a misleading retry prompt rather than a clear expired state, so a dead link looks like a transient glitch.
- **Fix:** The expiry check now runs before the `reserved` branch and independently of the stored status, after the `paid` and `canceled` checks, so any link past its expiry answers `410 payment_link_expired` whether it is still `active` or holds an uncleaned reservation. Backend only; the checkout page (`apps/web`) is owned by an in-flight redesign and its copy was left untouched. Test added.

### Bug: Recent ledger activity double-counts the boundary day (BHA-103)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** The recent ledger activity widget counted a transaction on the boundary business day in two adjacent date windows at once, so the same activity showed up twice when the dashboard sat two windows side by side.
- **Cause:** `getRecentLedgerActivity` (`apps/api/src/analytics/query.ts:306`) matched the day with `BETWEEN $2::date AND $3::date`, inclusive on both ends, while `to` is exclusive everywhere else (`parseDateRange`, `getVolumes`, `getTopLinks` all use `< $3`). The boundary day was the `to` day of one window and the `from` day of the next, so both windows claimed it.
- **Breaks:** An off-by-one at the boundary day overcounted a merchant's ledger activity; the boundary day's entries appeared in two windows instead of one. The day boundary is already computed in Asia/Bahrain per ADR-0003, so only the range ends were wrong.
- **Fix:** Replaced the inclusive `BETWEEN` with a half-open range in Asia/Bahrain, `(occurred_at AT TIME ZONE 'Asia/Bahrain')::date >= $2::date AND < $3::date`, so each business day belongs to exactly one window. Test added in `analytics/recentLedgerActivityBoundary.new.test.ts`.
### Bug: Transaction list and export crash on an invalid date range (BHA-82)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** Passing a `from` or `to` that is not a real date to `GET /v1/transactions` or `GET /v1/transactions/export` answered 500, though the export's own docstring promises a 400.
- **Cause:** Both routes did `q.from ? new Date(q.from) : undefined` with no check (`apps/api/src/routes/transactions.ts`). An unparseable value became an Invalid Date, which `pg` then failed to serialize, crashing the request.
- **Breaks:** Bad date input crashed the list and the export instead of returning the documented 400, and a stack trace was logged server-side on every hit.
- **Fix:** A `parseDateParam` boundary helper (next to the existing `parseLimit`/`assertValidCursor`) returns 400 `invalid_date` for a value that does not parse to a real instant, and both routes run `from`/`to` through it. Tests added in `routes/transactions.validation.test.ts`.

### Bug: Transaction export loads the whole result into memory (BHA-84)
- **Status:** Fixed
- **Type:** Performance, medium
- **Problem:** Exporting transactions ran one unbounded `SELECT *` and built the entire CSV in memory, so a large merchant's export could exhaust the API process.
- **Cause:** The route called `buildTransactionsExportCsv`, which reads every matching row at once (`apps/api/src/transactions/exportCsv.ts`). The paginated `streamTransactionsExportCsv` already existed but was never wired in.
- **Breaks:** A big merchant could OOM the API on export.
- **Fix:** The route now streams the CSV through `streamTransactionsExportCsv` into a `PassThrough`, which keyset-paginates at 1000 rows per page so the whole result is never held at once. Wiring it exposed a keyset precision bug in that function (it paged on a millisecond `Date` while `occurred_at` is microsecond `timestamptz`, re-reading the boundary row); it now pages on `(occurred_at, id)` using Postgres's own text rendering, the same keyset the list query uses. Test added in `routes/transactions.validation.test.ts` that exports across the 1000-row page boundary and checks every row appears exactly once.

### Not a bug: Transaction list crash on a non-numeric limit is already guarded (BHA-81)
- **Type:** UX
- **Claim:** The ticket reported that a non-numeric `limit` on the transactions list returned a 500.
- **Checked:** On current `main`, `GET /v1/transactions?limit=abc` returns 400 `invalid_limit`; `parseLimit` in `routes/transactions.ts` rejects any value that is not `^\d+$` or is below 1 before the query runs. Reproduced against a local DB: 400, not 500.
- **Why it is not a bug now:** The crash is already guarded, so this PR adds no code for it. A value above the cap is clamped to 100 by the documented `MAX_LIMIT` guard in `query.ts`, which is existing intended behaviour and is left alone.
### Bug: Scheme export amount overflows on a large capture (BHA-158)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** Closing a settlement batch that holds a large capture (BD value past eight integer digits, e.g. 100,000,000.00 BD) failed outright: the whole CloseBatch transaction aborted with a numeric field overflow, so the batch never closed.
- **Cause:** CloseBatch wrote a second, denormalised copy of the line amount into `scheme_export_lines.amount`, a `NUMERIC(10,2)` column (migration 0050), via `SchemeAmountBD`, a `float64(grossFils)/1000.0`. Fils are `BIGINT` everywhere (ADR-0001), and a large fils value does not fit `NUMERIC(10,2)`, so Postgres rejected the insert. The durable record, `amount_fils` (`BIGINT`), never overflows, and the export reader already preferred that column via COALESCE.
- **Breaks:** No batch containing a large capture could be closed; settlement stalled for that merchant and day. The float copy also disagreed with `amount_fils` by up to 9 fils (it rounded the untruncated gross), against ADR-0002's "amount must be exactly amount_fils / 1000 formatted to two decimals".
- **Fix:** Stop writing the overflow-prone float column at close (it is nullable and no reader needs it) and format the exported BD figure from the `BIGINT` `amount_fils` with the existing `formatFilsAsTwoDecimalString`, which is exact and cannot overflow. Removed the now-unused `SchemeAmountBD` float helper. No schema change. Test added: a 100,000,000.00 BD capture now closes and exports "100000000.00".

### Bug: Fee schedule MDR has no upper bound (BHA-118)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** A fat-fingered MDR such as 25000 bps (250%) is accepted into a merchant's fee schedule, then prices settlements at an absurd rate.
- **Cause:** `fee_schedules.mdr_bps` (migration `0048_fee_schedules.sql`) is only checked for `mdr_bps >= 0`, with no upper bound. The sibling rate column `merchants.negotiated_discount_bps` (migration `0047`) already caps at 10000 bps, so the ceiling was dropped only here. No application route inserts a fee schedule, so the database constraint is the write-time boundary.
- **Breaks:** A nonsense rate can enter the table unchecked and is later applied at capture and settlement, producing nonsense fees and payouts.
- **Fix:** Additive migration `0077_fee_schedules_mdr_upper_bound.sql` adds a named CHECK `mdr_bps <= 10000` alongside the existing `>= 0` check, matching the 10000 bps cap on `negotiated_discount_bps`. No data rewrite: every existing row is a normal rate. Test added that an insert of 25000 bps is rejected with a check-constraint violation.
### Bug: Platform volume counter overflows int32 (BHA-48)
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** Once the platform's lifetime processed volume passes 2,147,483,647 fils (about 2,147,483 BD), the running counter wraps to a negative value, so the volume-based fee tier reads a wrong total and stops applying the discount it should.
- **Cause:** `apps/settlement/internal/settlement/platform_volume.go` read, accumulated and compared the counter as `int32`, casting each batch's gross with `int32(batchGrossFils)` and summing into an `int32`, then storing into `platform_stats.total_processed_fils`, an `INTEGER` column (migration 0049). The counter only ever grows and `apps/api/src/fees/platformVolumeTier.ts` already treats the column as a 64-bit value, so the two sides disagreed above the ceiling. Latent today because real volume has not reached it.
- **Breaks:** Above the ceiling, every merchant's volume-tier MDR bonus is priced off a wrapped, negative total: the discount silently turns off, so merchants are overcharged against the stated fee schedule.
- **Fix:** Widened the three functions in `platform_volume.go` to `int64` (the DB round-trip no longer narrows) and added migration `0076_platform_stats_total_bigint.sql` widening the column to `BIGINT`. Additive and data-preserving: a type widen keeps every existing value and the default. Test added: a lifetime total accumulated past the old int32 ceiling reads back as the true positive sum and still trips the tier.
### Bug: Reporting transactions silently truncates at 500 rows (BHA-105)
- **Status:** Fixed
- **Type:** Data, high
- **Problem:** `GET /v1/reporting/transactions` returned at most 500 rows and gave no sign more existed, so a merchant with more than 500 matching transactions quietly lost every row past the first 500 from their report.
- **Cause:** `runTransactionsReport` ran a single `... ORDER BY occurred_at DESC LIMIT 500` with no pagination and returned a bare array (`apps/api/src/reporting/transactionsReportQuery.ts`), so rows beyond 500 were dropped with nothing to signal the cut.
- **Breaks:** Reports and reconciliation built on this endpoint understated a busy merchant's activity with no error or warning.
- **Fix:** Keyset-paginate on `(occurred_at, id)` with a `nextCursor`, the same pattern the transactions list and export already use (`apps/api/src/transactions/query.ts`, BHA-89). The query returns a bounded page (house default 25, max 100) plus a `nextCursor`, so the caller reads the whole result set and knows when more remains instead of losing rows in silence. Only the needed columns are selected and all values stay parameterized. Test added that pages the full set by cursor and checks every row appears exactly once.
### Bug: Webhook failed-status filter is a permanent no-op (BHA-143)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** On the webhook endpoint deliveries list, filtering by the "failed" status always returned zero rows, so a merchant could never see their failed deliveries through that filter.
- **Cause:** The deliveries list query filters `webhook_deliveries.status = ANY($statuses)` with the status strings passed straight through (`apps/api/src/webhooks/deliveries.ts`). The dispatcher only ever writes `pending`, `succeeded` or `exhausted` (`dispatcher.ts`): a delivery that uses up every attempt is stored as `exhausted`. `failed` is a value in the schema CHECK constraint (migration 0022) that nothing writes, so `status = 'failed'` matched nothing.
- **Breaks:** A filter option that can never match anything misled the user into thinking there were no failed deliveries.
- **Fix:** Map the user-facing `failed` filter value onto the stored `exhausted` status inside the shared list query, so filtering by `failed` returns the real permanently-failed deliveries. Parameterized SQL unchanged. Test added in `routes/webhooks.test.ts` that drives a delivery to `exhausted` and asserts the `failed` filter returns it.
### Bug: Settlement batch list mixes rows from a previous filter on a slow response (BHA-172)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** On the merchant settlement batch list, changing the date or status filter while a previous request was still in flight let the stale response land last, appending wrong-filter rows and overwriting the current filter's pagination cursor.
- **Cause:** `apps/web/src/pages/settlement/SettlementBatchListPage.tsx` `load` had no stale-response guard. It is recreated on every filter change and the effect re-fires, but an older in-flight response still ran `setBatches`/`setNextCursor`, and the Load more button dispatches the same `load` outside any effect, so the existing effect-cleanup pattern did not cover it.
- **Breaks:** A filtered view (e.g. status=paid) could briefly show a batch from the unfiltered set, and the next Load more sent the current filter with the stale cursor.
- **Fix:** A request epoch held in a `useRef`, bumped on every filter change, captured in the `load` closure at dispatch and checked before `setBatches`/`setNextCursor`/`setError`/`setLoading`, so a response for a superseded filter is dropped. Same "capture in the closure, guard before setState" shape as the sibling `SettlementBatchDetailPage` cancelled flag, widened to cover both the filter effect and the imperative Load more path. No test: a frontend ordering race is visible on the page and the repo does not unit-test this hook pattern.
### Bug: Promotional discount parser reads BD as two-decimal cents (BHA-59)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** `parsePromotionalDiscountFils("4.75")` returned 475 fils instead of 4750, and "4.7555" was silently rounded instead of rejected.
- **Cause:** `apps/api/src/payments/discountAdjustment.ts` parsed the BD string with `parseFloat` and multiplied by 100, while BD has three decimals and ADR-0001 requires text amounts to go through `parseBhdToFils`, never through float maths.
- **Breaks:** Nothing today: no route, script or other service calls this parser, and the live capture discount (`applyCaptureDiscountAdjustment`) works in basis points on the charged fee, so the ticket's claim that every capture adjustment is a tenth of the intended amount is false. It shipped because the exported function breaks ADR-0001, and the first caller wired to it would post a tenth of every promotional discount.
- **Fix:** The parser now uses the shared `parseBhdToFils` from `packages/money`, the same shape as the CSV import fix, and still rejects malformed, negative or four-decimal input with `invalid_discount`. Test added.

### Bug: Settlement batch transactions list has no row limit (BHA-114)
- **Status:** Fixed
- **Type:** Performance, low
- **Problem:** `GET /v1/settlement/batches/:id/transactions` returned every line of a batch in one response, however large the batch, and ignored `limit`.
- **Cause:** `listBatchTransactions` in `apps/api/src/settlement/query.ts` ran its query with no `LIMIT` and the route read no paging parameters, on the assumption, left in a code comment, that a batch stays small.
- **Breaks:** A busy merchant's batch could produce an arbitrarily large response and query, the unbounded read the performance rules forbid.
- **Fix:** Keyset pagination on `line_sequence`, the same `limit` (default 25, max 100) and opaque `nextCursor` shape as the settlement batch list; a malformed cursor is a 400 `invalid_cursor`. The merchant web client follows `nextCursor` to the last page, so the batch detail page still lists every line of the settlement figure and the page itself is unchanged. Test added.

### Bug: Settlement batch transactions show the lifetime capture, not what the batch settled (BHA-161)
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** After a later partial capture on a transaction, a closed batch's transaction list changed its Captured figure (for example 4.000 BD became 7.000 BD) and no longer matched the batch's own scheme amount, showing a discrepancy that does not exist.
- **Cause:** `listBatchTransactions` read `transactions.captured_fils`, the running lifetime total, while CloseBatch builds each line from the capture events it stamps with that batch's `settlement_batch_id`.
- **Breaks:** Historical batch detail rewrote itself after the fact, so a merchant or finance reviewer reconciling a closed batch saw a false mismatch.
- **Fix:** Captured is now the sum of that transaction's capture events stamped with this batch, the same deltas CloseBatch used. The column already existed, so no schema change. Test added: capture 4.000 BD, close the batch, capture 3.000 BD more, and the batch still shows 4.000 BD. The seed now stamps its ready-made closed batches on their capture events too, so freshly seeded demo batches show their real Captured figure.
- **Seed:** The seed now stamps its ready-made closed batches on their capture events too, so freshly seeded demo batches show their real Captured figure. PR: https://github.com/SilentYsf/fils-pay/pull/101

### Bug: A database error after the acquirer approves a refund or capture moves the money again on retry (BHA-170)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** If the database failed after the acquirer had approved a refund or capture (a deadlock, a dropped connection, a constraint), the request failed with nothing recorded, and retrying it with the same Idempotency-Key made the acquirer refund or capture a second time.
- **Cause:** `processRefund.ts` and `capture.ts` run the idempotency claim, the acquirer call and the journal in one transaction, and built the acquirer's idempotency key from the claim's row id. The rollback discarded that row, so the retry got a new row id, a new acquirer key, and a fresh refund or capture instead of the acquirer's cached first answer.
- **Breaks:** Money left the acquirer twice for one client request, and the first movement never reached the ledger.
- **Fix:** The acquirer key is now built from the claim's own scope (merchant, endpoint, client Idempotency-Key) plus the attempt count, so a retry after a rollback reuses the first key and the acquirer replays its approval; the journal then posts once. The attempt count stays so a retry after a recorded acquirer error still gets a fresh acquirer call. No schema change. Test added for both paths: a trigger rejects the ledger insert after approval, then the retry must reach the acquirer under one key and post one ledger entry. `authorize.ts` builds its key the same way and is left for a follow-up because another open PR is editing it.
- **Known limit:** A full refund sent without `amountFils` resolves its amount inside the transaction. If another refund on the same transaction commits between the rolled-back try and the retry, the retry asks the acquirer under the same key for a smaller remainder, and the acquirer replays the first, larger answer. Keying on the resolved amount would close it.
### Bug: A database error after the acquirer approves an authorization places a second hold on retry (BHA-181)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** If the database failed after the acquirer had approved a card authorization, the request failed with nothing recorded, and retrying it with the same Idempotency-Key made the acquirer place a second hold on the cardholder's funds.
- **Cause:** `authorize.ts` runs the idempotency claim, the acquirer call and the transaction insert in one transaction, and built the acquirer's idempotency key from the claim's row id. The rollback discarded that row, so the retry got a new row id and a new acquirer key instead of the acquirer's cached first answer.
- **Breaks:** The cardholder had two holds for one client request, and the first never reached the ledger.
- **Fix:** The acquirer key is now built from the claim's own scope (merchant, endpoint, client Idempotency-Key) plus the stored request hash and the attempt count, so a retry of the same request after a rollback reuses the first key and the acquirer replays its approval, while a different request under the same client key (another payer reclaiming a payment link) gets a new key and is never handed the first card's approval. Refunds and captures got the request hash too. No schema change. Test added: a trigger rejects the transaction insert after approval, then the retry must reach the acquirer under one key; a second test changes the body on the retry and must reach it under a new key.
### Bug: A freshly seeded stack shows blank analytics and a "No data yet" badge (BHA-176, BHA-175)
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** After `npm run seed`, the analytics volume and payout widgets were empty and their freshness badge said "No data yet", while the live Top paid links widget next to them showed data. Only a manual `reporting rebuild` or catch-up filled them.
- **Cause:** The rollups (`merchant_daily_volume`, `merchant_payout_trends`) are only ever filled by the reporting consumer replaying `outbox_events`. The seed truncates both rollups and `reporting_outbox_cursor`, writes the outbox events, and never runs a consumer pass. `readModelAsOf` for those two widgets comes from `reporting_outbox_cursor.updated_at`, which no pass has created, so the API returns `null` and the badge (BHA-175) reads that same missing cursor row.
- **Breaks:** Demo and local runs started with blank analytics and a badge that contradicted the page, until someone ran the reporting CLI by hand.
- **Fix:** `db/seed/index.ts` now runs the existing `runCatchUp` from `apps/reporting` after the assertions, the same consumer pass the worker runs, so there is no second fill path. It must run after the assertions because the `seed-deterministic` check re-runs `generate()`, which truncates the rollups and cursor again. No schema change and no change to `apps/web`. The seed's outbox is a small sample (a few events per merchant), so the filled rollups are sparse and the consumer's own parity warning prints for two batches; a per-capture outbox in the seed would be a separate change. No test: seed data, with the row counts and endpoint output in the PR.
### Bug: A webhook receiver can make the API read an unbounded response (BHA-144)
- **Status:** Fixed
- **Type:** Performance, medium
- **Problem:** A receiver that answers with a huge or never-ending body made the API keep reading and holding it, for every delivery and every test-send.
- **Cause:** `createFetchTransport` in `apps/api/src/webhooks/transport.ts` appended every chunk to a string with no limit, although the dispatcher and test-send only keep the first 2000 characters of it.
- **Breaks:** A fast receiver could push hundreds of MB into one delivery's memory on the 2 GB host, and a string past V8's limit throws a RangeError inside the data listener, which can take the API process down.
- **Fix:** The transport stops reading at 64 KiB (`MAX_RESPONSE_BODY_BYTES`), destroys the response and resolves with the status code and the truncated body, once. The whole-exchange timeout is unchanged. Test added: a local receiver streams without end and the transport resolves in milliseconds, not at the timeout.
### Bug: The stored card payment hash can be brute-forced back to the card (BHA-177)
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** Every card authorization stored a plain sha256 of a JSON body holding the full card number, expiry and CVV in `idempotency_keys.request_hash`.
- **Cause:** `authorizeTransaction` in `apps/api/src/payments/authorize.ts` passed the card into `hashRequest`, an unkeyed sha256. It runs for `POST /v1/payment-links/:token/pay` and `POST /v1/transactions`.
- **Breaks:** The link amount and reference are known, and a card number, expiry and CVV form a small enough space to try every value, so anyone who reads that table can recover cards and CVVs. PCI forbids storing the CVV in any form after authorization.
- **Fix:** A new `hmacRequest` in `payments/idempotency.ts` hashes the same canonical body with HMAC-SHA256 under a server key, and authorize uses it. The key comes from a new `CARD_FINGERPRINT_KEY` (base64 of 32 bytes), required in production and checked at boot like `WEBHOOK_SECRET_ENCRYPTION_KEY`. Capture and refund bodies hold no card and keep the plain hash. No schema change. Rows written before the deploy keep their old hash: an authorize retried after the deploy with the same idempotency key gets a 422 `idempotency_key_reused` (on a payment link, a 409 that leaves the reservation alone) instead of a replay. That fails closed, never charges twice, and in practice hits only retries that were already in flight. Test added.
### Bug: Lifetime payout estimate drifts for high-volume merchants (BHA-26, BHA-128, BHA-129)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** The running lifetime payout total on a merchant (`merchants.lifetime_net_payout_monitoring_estimate`) stopped matching the sum of that merchant's payouts once it passed about 16,777 BD, and drifted further with every batch. Split parents' total (BHA-129) never moved at all.
- **Cause:** `UpdateLifetimePayoutMonitoringEstimate` (`apps/settlement/internal/settlement/payout_estimate.go:19`) passed `float32(netPayoutFils)` into a `REAL` column (0040), and a 32-bit float holds every integer only up to 2^24 fils, so each addition past that rounded. `EstimateMonthlyPayout` summed fils in a `float32` the same way.
- **Breaks:** ADR-0001 (money is integer fils). Nothing in Go, the TS API or the web apps reads the figure back, so no payout or balance was wrong; the ops figure was.
- **Fix:** Migration 0078 changes the column to `BIGINT` (type change only, nothing dropped), the payout code adds `int64` fils, `EstimateMonthlyPayout` sums `int64`, and the seed sums exactly instead of rounding through `Math.fround`. Test added: three payouts totalling 5,016,777,221 fils land on the exact sum (it read 5,016,777,216 before). The old small-value test now scans an `int64`. `splits.PayoutSplitBatch` never bumped the estimate, so it now runs the same UPDATE in its transaction with the batch's net payout (inlined, because `settlement` imports `splits`). Test added: a split parent's estimate equals its batch net after payout. A negative net is skipped, as `PayoutBatch` refuses one. Split-parent payouts made before this change are not backfilled into the estimate. PR: https://github.com/SilentYsf/fils-pay/pull/106
### Bug: The webhook backoff test failed on every run (BHA-182)
- **Status:** Fixed
- **Type:** Time, low
- **Problem:** The dispatcher test "failing endpoint: backoff/exhaustion sequence" failed on `main` even when run alone, with a different value each run (`1009 !== 1000`, `1078 !== 1000`), so the suite was red and hid real regressions.
- **Cause:** `backoffDelayMs` applies ±10 % random jitter on purpose (`apps/api/src/webhooks/dispatcher.ts:48-58`, with an injectable `jitter` parameter), but the test asserted an exact 1000 and 2000 from the unseeded call (`dispatcher.test.ts:198-199`, `:218-219`). `ARCHITECTURE.md:63` only requires exponential backoff, so no doc rules jitter out and the code is right.
- **Breaks:** A permanently red test that taught the team to ignore webhook failures, and a real retry-schedule regression would not have stood out.
- **Fix:** The test now passes `() => 0.5` for the exact base delay and asserts the 900 and 1100 jitter bounds with `() => 0` and `() => 1`. No production code changed and no assertion was weakened. Test updated in `dispatcher.test.ts`; it failed before and passes 3 of 3 runs after.

### Bug: The database accepts an over-refund, an absurd merchant MDR rate and a negative payout (BHA-122, BHA-117, BHA-119)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** A transaction could be refunded past what was captured, a merchant could carry a negative or 250000% MDR rate, and a settlement batch could store a negative net payout, with nothing at the database refusing it.
- **Cause:** `0043` checked `refunded_fils >= 0` only, `merchants.mdr_bps` (`0002`) had no CHECK, and `settlement_batches.net_payout_fils` (`0006`) had no sign check. Only application code guarded them.
- **Breaks:** Any bad write or future bug (a second refund path, a fat-fingered rate) was stored silently and surfaced later as a wrong fee or payout.
- **Fix:** New additive migration `0079_money_check_constraints.sql` with three named CHECKs: `refunded_fils <= captured_fils`, `mdr_bps BETWEEN 0 AND 10000` (same range as `fee_schedules`, 0077), `net_payout_fils >= 0`. `gross_fils` and `fee_fils` are left unconstrained because a carried-forward refund can legitimately make a batch fee negative. Test added: `apps/api/src/db/moneyChecks.new.test.ts`. `RecalculateMDR` (`apps/settlement/internal/settlement/recalculate_mdr.go`) now skips a batch whose recalculated net would be negative (a fully refunded day whose rate was raised) and returns its id in `skipped`, instead of failing the whole range; before the CHECK it stored the negative net and the batch got stuck. Test added: `TestRecalculateMDR_SkipsBatchWhoseNetWouldGoNegative`.
### Bug: Recent ledger activity silently stops at 200 rows
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** A merchant with more than 200 ledger entries in the chosen dates saw only the newest 200, with no sign that more existed.
- **Cause:** `getRecentLedgerActivity` in `apps/api/src/analytics/query.ts` ended in a hard `LIMIT 200` with no cursor and ordered by `occurred_at` alone, so there was no way to ask for the rest.
- **Breaks:** Any ledger total or audit built from this list was short without warning.
- **Fix:** The query now orders by `(occurred_at, id) DESC`, filters on a keyset cursor and returns `nextCursor`, the same pattern as `reporting/transactionsReportQuery.ts`. The route accepts `?cursor=`, and a bad cursor answers 400 instead of restarting at page one. Test added in `recentLedgerActivityBoundary.new.test.ts` (206 rows over two pages, plus a bad cursor). No web page calls this endpoint yet, so there is no client to update.

### Improvement: The settlement batch progress bar takes its width from integer fils
- **Type:** UX
- **Before:** The progress bar on a closed batch took its width from `parseFloat((grossFils / 10000).toFixed(2))` in `SettlementBatchDetailPage.tsx`, which rounds a fils amount through a decimal float. The bar width could be off by a fraction of a percent at most; no money was stored, sent or shown wrongly.
- **Why it shipped:** ADR-0001 keeps money in integer fils until display, and this was the one place on the page that left that rule. The fix is one expression, so it was cheaper to align it than to leave a float on a money value for the next reader to copy.
- **Change:** The percentage is now `Math.floor(grossFils / 10000)` clamped to 0 to 100, computed from the integer fils for display only.

### Bug: MDR recalculation pays back discount rebates that were never posted
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** Running `POST /internal/recalculate-mdr` at an unchanged rate credited a merchant fils they were never owed when a batch held a capture whose negotiated-discount rebate posted short or not at all. Capture 10 000 at 250 bps with a 1000 bps discount, refund 9 500 before the discount posts (BHA-169 then rebates 1, not 25), then refund the last 500: the batch closes at a fee of 250 - 1 - 249 = 0, but the recalculation priced it at 225 - 249 = -24 and posted a 24 fils `MDR recalculation adjustment` to the merchant.
- **Cause:** `recomputeBatchFee` in `apps/settlement/internal/settlement/recalculate_mdr.go` priced every event with the full negotiated discount, while `CloseBatch` (`batch.go`) charges a capture's fee less the rebates `discountAdjustment.ts` actually posted. The two disagree whenever a rebate did not post in full: a failed discount call, a payment-link capture whose discount failed, or a refund that landed before the discount.
- **Breaks:** Every recalculation moved the batch fee and the merchant's balance away from the ledger by the rebate that never posted, and a later payout paid it out.
- **Fix:** `recomputeBatchFee` now reads the same posted `capture: negotiated discount adjustment` rebates `CloseBatch` reads, for the batch's transactions in its business day, and subtracts them. A transaction whose capture posted its own `capture: MDR fee` leg (the leg the rebate is computed from) is priced at the MDR alone; one without it, such as a seeded capture whose fee already has the discount taken off, keeps the discount priced in as before. Test added: `TestRecalculateMDR_ShortRebateUnchangedRateAdjustsNothing` replays the example and fails on `main` with a -24 adjustment.
### Bug: A resent manual credit or balance adjustment moves the money twice
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Sending the same admin credit (under the 50 BD approval line) or balance adjustment twice, as a client does when its first request times out, posted it twice: one 5.000 BD credit left two credit requests and 10.000 BD on the balance.
- **Cause:** `POST /v1/admin/merchants/:id/credits` and `POST /v1/admin/merchants/:id/balance-adjustments` took no Idempotency-Key, and `createCreditRequest` and `applyBalanceCorrection` had nothing that tied a second identical request to the first.
- **Breaks:** A proxy or client resend of the same request, or two concurrent submits, credited the merchant's balance twice with nobody approving the second. (A fresh click after an error is a new request with a new key, by design.)
- **Fix:** Both routes now require an Idempotency-Key header, the same contract as authorize and capture. The key is claimed with `claimIdempotencyKey` inside the same transaction as the ledger or balance write and completed with the result, so a resend replays the first answer, a reused key with a different body is a 422, and a concurrent duplicate waits on the key's unique index. The admin console sends a fresh key per submit. Tests added in `adminCredits.test.ts` and `adminBalanceAdjustments.test.ts`; both fail on `main` and pass with the change.
### Bug: Our totals are always a few fils under the scheme statement
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Finance found the ledger and the scheme statement never agreed: every batch, the card scheme clearing account held a few fils more than the scheme file sent.
- **Cause:** The scheme file carries two decimals, so `CloseBatch` truncates each line to 10 fils (`apps/settlement/internal/settlement/batch.go:428`), but nothing journalled the 0 to 9 fils it dropped, although ADR-0002 says CloseBatch posts them and `docs/HANDOVER.md:20-21` admits the posting was never written.
- **Breaks:** Reconciliation between the ledger, the batch and the scheme statement never closes, and the gap grows with every capture.
- **Fix:** `CloseBatch` now posts, per export line with a residue and in the same transaction, `card_scheme_clearing` credit and `scheme_rounding_residue` debit for gross minus the truncated amount (`batch.go:441-455`), as ADR-0002 specifies. Finance must stop booking residue by hand from the deploy date. PR: https://github.com/SilentYsf/fils-pay/pull/111. Test added: `TestCloseBatch_JournalsSchemeRoundingResidue`.
### Bug: A refund that races the capture discount over-credits the merchant
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** For a merchant with a negotiated discount, a refund that landed after a capture but before its discount posted (or before a failed discount was replayed) still got the full discount afterwards. A full refund left the platform fee for that transaction at -25 fils on a 250 fils fee, and a partial refund left the merchant the discount on the part already refunded.
- **Cause:** `applyCaptureDiscountAdjustment` (`apps/api/src/payments/discountAdjustment.ts`) posts the discount in its own transaction after capture commits, and sized it from the capture's gross fee with no look at refunds. `processRefund` reverses the fee net of the discounts already posted, so a refund that took the row lock first reversed the gross fee and the discount was then paid on top. The old replay guard counted adjustment rows against capture events, so any rebate that legitimately posts nothing would leave that count short and let a later capture's rebate replay twice.
- **Breaks:** The merchant payable ended above the ledger's truth by up to the whole discount per affected transaction, and settlement paid it out.
- **Fix:** Under its existing row lock the adjustment now reads the transaction's `platform_fee_revenue` legs in id order. It rebates the discount on the MDR fee legs posted since the last adjustment (so a replay finds nothing new and a skipped rebate cannot desync a count), and each refund reversal posted after a capture's fee leg shrinks the rebate owed on that capture by the share of the fee it reversed, which gives the same result as a discount that posted before the refund. A refund before a capture never touches that capture's rebate. The owed amount is an exact fraction, rounded once. Both callers, the capture route and the payment-link pay path, go through this one function. One behaviour change: an earlier capture whose discount call failed is now rebated with the next capture on the same transaction. MDR recalculation still prices the full discount and can disagree with a short rebate; that is filed as BHA-183. PR: https://github.com/SilentYsf/fils-pay/pull/110
- **Test added:** Five tests in `discountAdjustment.test.ts` drive the real `processRefund`: a full refund before the discount (nothing rebated), a partial refund of 9 500 before it (1 rebated, 11 kept, the same as discount-first), a skipped rebate followed by a second capture and its replay (15 posted once), a refund between a second capture and its discount (6 rebated, 90 kept), and a refund before a second capture (that capture still gets its full 15). The first four fail on `main`; the fifth guards the normal multi-capture path.
### Bug: Lifetime payout estimate drifts for high-volume merchants (BHA-26, BHA-128, BHA-129)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** The running lifetime payout total on a merchant (`merchants.lifetime_net_payout_monitoring_estimate`) stopped matching the sum of that merchant's payouts once it passed about 16,777 BD, and drifted further with every batch. Split parents' total (BHA-129) never moved at all.
- **Cause:** `UpdateLifetimePayoutMonitoringEstimate` (`apps/settlement/internal/settlement/payout_estimate.go:19`) passed `float32(netPayoutFils)` into a `REAL` column (0040), and a 32-bit float holds every integer only up to 2^24 fils, so each addition past that rounded. `EstimateMonthlyPayout` summed fils in a `float32` the same way.
- **Breaks:** ADR-0001 (money is integer fils). Nothing in Go, the TS API or the web apps reads the figure back, so no payout or balance was wrong; the ops figure was.
- **Fix:** Migration 0078 changes the column to `BIGINT` (type change only, nothing dropped), the payout code adds `int64` fils, `EstimateMonthlyPayout` sums `int64`, and the seed sums exactly instead of rounding through `Math.fround`. Test added: three payouts totalling 5,016,777,221 fils land on the exact sum (it read 5,016,777,216 before). The old small-value test now scans an `int64`. `splits.PayoutSplitBatch` never bumped the estimate, so it now runs the same UPDATE in its transaction with the batch's net payout (inlined, because `settlement` imports `splits`). Test added: a split parent's estimate equals its batch net after payout. A negative net is skipped, as `PayoutBatch` refuses one. Split-parent payouts made before this change are not backfilled into the estimate. PR: https://github.com/SilentYsf/fils-pay/pull/106

### Bug: Production login codes are generated but never delivered
- **Status:** Fixed
- **Type:** Security, high
- **Problem:** With `NODE_ENV=production` no merchant or admin could log in, because the OTP code was created and never sent anywhere. The hosted box worked around it with `OTP_DEV_EXPOSE=true`, which put every account's code in the login response.
- **Cause:** Both notifiers (`auth/notifier.ts`, `adminAuth/notifier.ts`) only log that a code was made, and the code comment claiming no email or SMS integration was needed is false: `OTP_DEV_EXPOSE` was the only way a code ever reached a person.
- **Breaks:** Either nobody can log in to the hosted app, or anyone who knows a password also gets that account's second factor on screen.
- **Fix:** Production still delivers no code to real accounts until an email provider exists. A new `OTP_EXPOSE_EMAIL_DOMAINS` list (empty by default) names the seeded demo domains, and only logins on those domains see their code on screen, for merchant login, merchant code resend and admin login. One helper, `exposesOtpCode`, decides it for all three. `OTP_DEV_EXPOSE` still shows every code in dev and test, and the API now warns at boot if it is on in production. Test added in `routes/auth.test.ts`.
### Improvement: The merchant app's root opens the dashboard
- **Type:** UX
- **Before:** The merchant app's root URL showed a bare "404 Not Found" page, because its router has no `/` route. Nothing promised a page there and nothing broke.
- **Why it shipped:** The root is the first URL anyone opens, judges included; the hosted box already redirects it in nginx, but the app itself should not depend on the proxy for that.
- **Change:** One route in `apps/web/src/router.tsx` sending `/` to `/dashboard`, the same shape as the existing `/dashboard` redirect; signed-out users land on the login form.
### Bug: Settlement Go suite only passes on a fresh database (BHA-186)
- **Status:** Fixed
- **Type:** Deploy, low
- **Problem:** Running `go test ./...` in `apps/settlement` a second time on the same database failed nine CloseBatch tests in `internal/settlement` and one in `internal/internalapi`, all with fees 15 bps too low.
- **Cause:** `TestSchemeExportLargeCaptureDoesNotOverflow` closes a 100,000,000 BD batch, which adds that gross to `platform_stats.total_processed_fils` and leaves the counter far past the 2,000,000 BD volume-tier threshold. Every later CloseBatch on that database got the 15 bps tier bonus that the fee assertions do not expect.
- **Breaks:** Anyone re-running the suite, including a hidden regression run, saw false fee failures on code that was correct.
- **Fix:** The test now saves the counter before its close and restores it in `t.Cleanup`, the same way `TestCloseBatch_PaysTheFeeJournaledAtCapture` already does. No assertion changed. Three runs in a row on one database now pass with `go test -p 1 ./...`. The suite can still fail now and then when packages run in parallel, because of a separate balance cache bug that is reported on its own.
### Bug: The admin webhook replay "failed" status replays nothing
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** On the admin Webhook Replay page, choosing the "failed" status replayed zero deliveries, even for an endpoint full of permanently failed ones.
- **Cause:** `replayWebhookDeliveriesBatch` filters `status = ANY($2)` with the statuses as sent, and the dispatcher never writes `failed`: a delivery that uses up its attempts is stored as `exhausted`. It is the same cause as BHA-143 on the merchant list.
- **Breaks:** An operator who picked "failed" to resend failed webhooks got an empty result and no hint that "exhausted" was the option that worked.
- **Fix:** `replayBatch.ts` maps the `failed` filter value onto `exhausted` (deduped), the same mapping BHA-143 added in `deliveries.ts`. Test added in `admin.test.ts`: red (0 matched) before, green after.
### Bug: Approving your own credit shows a raw error code
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** An admin who approved a credit request they raised saw `self_approval_forbidden` in the error banner instead of a sentence.
- **Cause:** `CreditsPage` passed every failure to `describeError`, which prints the API's `message` or else its raw `code`, and the API raises this one as a bare code (`creditApproval.ts:13`).
- **Breaks:** The refusal was correct, but the admin could not tell why it happened or what to do next.
- **Fix:** `handleApprove` shows "You can't approve a credit you requested. Ask another admin to approve it." for that code and leaves every other error unchanged. The admin app has no shared code-to-message map, so the fix stays in the one component.
### Bug: The March sweep script is not safe to run twice
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** The script that patched the March scheme rounding gap doubled it when run twice on staging. It also took the residue off what merchants are owed, and missed residue lost on split captures.
- **Cause:** `scripts/reconcile_march.ts:74` posted a new `randomUUID` journal group on every run. The dedupe claimed at `:71` and in `docs/RUNBOOK.md:123` did not exist. The legs at `:78-79` debited `merchant_payable`, where ADR-0002 says credit `card_scheme_clearing`. `:41` took the residue from cumulative `captured_fils` instead of each scheme export line.
- **Breaks:** Every extra run moved money again. Merchant payables were reduced by the residue. Rounding lost across several captures went unrecorded.
- **Fix:** The sweep now posts one ADR-0002 group per export line, with the line's transaction and batch, and computes the residue as gross minus `amount_fils`. It runs under an advisory lock in one transaction and skips any batch that already carries residue legs. A second run, or a batch CloseBatch already journalled, posts nothing. It aborts if a line's residue is outside 0 to 9 fils, and it refuses to post over unreversed old-script rows. Batches are picked by a March `batch_date` (the Bahrain business month), so a batch is swept whole. Tests added in `scripts/reconcile_march.integration.test.ts`. PR: https://github.com/SilentYsf/fils-pay/pull/127

### Bug: A balance rebuild during the day double-counts that day's captures at close
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** After a balance rebuild, the next settlement close added the day's captures to the merchant's cached balance a second time. A 10,000 fils capture plus a 1,500 fils credit, then a rebuild, then the close left the cache at 21,000 fils against a batch net of 11,250, and at 9,750 after the payout instead of 0.
- **Cause:** `merchant_balances` had two meanings. The rebuild (`ledger.RebuildAllBalances`, ADR-0007) wrote the ledger's `merchant_payable`, which counts a capture the moment it posts, while `CloseBatch` step 14 (`balances.ApplyBatchClose`) adds the batch net at close, assuming the cache only holds closed batches. Manual credits were also added to the cache at posting, with the close adding only `net - credits`.
- **Breaks:** Any rebuild between a capture and its close inflated the payable figure ops see on the merchant page by that day's net, and it never came back down.
- **Fix:** The cache now means "closed but not yet paid out", which is what `ApplyBatchClose`, `ApplyPayout` and their missing-row rules already assumed. Both rebuild functions write `SUM(net_payout_fils)` of the merchant's closed batches under the same table lock (the per-merchant one since BHA-200), a posted credit no longer writes the cache, and step 14 adds the whole batch net. ADR-0007 has an amendment saying so. Test added (`TestRebuildThenClose_CountsEachCaptureAndCreditOnce`).

### Bug: Resending an adjustment CSV import posts every row again
- **Status:** Fixed
- **Type:** Money, high
- **Problem:** Uploading the same adjustment CSV twice applied every adjustment twice, to the ledger and to the balance.
- **Cause:** `applyAdjustmentImport` had no idempotency at all; a code comment in the route admitted it.
- **Breaks:** A retried or double-clicked upload paid every merchant in the file twice.
- **Fix:** No schema change. Inside the import's own transaction it claims one `idempotency_keys` row per merchant in the file, keyed on a hash of the file's rows, in sorted order so two uploads cannot deadlock. A resend, even under another file name, replays the first result and posts nothing. A file with exactly the same rows can no longer be posted twice on purpose; finance changes a reason or splits it. Test added.
### Bug: Recalculate MDR moves a fil on discounted merchants with no rate change (BHA-171)
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** For a merchant with a negotiated discount, running Recalculate MDR at the same rate rewrote the fee of a closed batch of seeded captures and posted an adjustment, for example a seeded 600 fils capture at 2.5% with a 10% discount went from a fee of 13 fils to 14. Seeded captures carry the discount inside their fee and have no separate `capture: MDR fee` leg; live captures with that leg are already priced right since #117 (BHA-183).
- **Cause:** The API and the ledger price a discount off the MDR fee (capture.ts posts `applyRateFils(amount, mdr)`, discountAdjustment.ts rebates `applyRateFils(fee, discount)`), and CloseBatch charges that journaled fee less the posted rebate. Go's `ComputeSettlementFee` took the discount off the amount first, then charged MDR, and the two orders land a fil apart at about one point in five. RecalculateMDR and CloseBatch's fallback for events without a journaled fee both use `ComputeSettlementFee`.
- **Breaks:** Recalculate MDR charged or refunded discount merchants with seeded captures fils they were never owed, and a fallback-priced batch did not match the ledger. ADR-0001 fixes one half-to-even rounding per rate but not the order, so we kept the order the ledger, the seed and the fee estimate already use.
- **Fix:** `ComputeSettlementFee` in `discounted_fee.go` now computes the MDR fee on the amount, then subtracts the discount off that fee, the same two steps as the ledger. Neither step multiplies two rates, so nothing new can overflow int64. Its test table now holds the fees the TS code gives for the same inputs, including two half-to-even ties; three rows fail on `main` (602/275/1250 gave 14, want 15). `ARCHITECTURE.md` stated the old order and is corrected.
### Bug: The seed wipes any database it is pointed at, and the March batch closes at zero
- **Status:** Fixed
- **Type:** Data, high
- **Problem:** Running `npm run seed` against a hosted or shared database erased merchants, transactions, the ledger and admin users with no warning. Separately, the seeded March captures had no `captured` events, so closing the March settlement batch showed zero gross.
- **Cause:** `db/seed/generate.ts` ran `TRUNCATE ... CASCADE` with no check of the target (the comment called it safe for shared databases). The March block inserted transactions and ledger postings but no `transaction_events`, which is the only thing `CloseBatch` reads.
- **Breaks:** One wrong `DATABASE_URL` destroys live data; a March reconciliation built on the seed starts from an empty batch.
- **Fix:** `generate()` now calls `assertSeedTargetAllowed`, which refuses unless the host `pg` resolves is localhost, 127.0.0.1, ::1 or the Compose `postgres` service, or `SEED_ALLOW_TRUNCATE=1` is set (the `?host=` override is covered because it checks pg's resolved host). The March loop writes a `captured` event per ledger group with `feeFils` from its fee leg, as `capture.ts` does. Ledger rows and checksum are unchanged. Tests in `db/seed/generate.test.ts`. Covers BHA-157.
### Bug: Webhook archive create and replay are unbounded
- **Status:** Fixed
- **Type:** Concurrency, medium
- **Problem:** Archiving or replaying a busy endpoint's history ran as one request over every delivery in the range, with no limit, while the batch replay and the dispatcher stop at 500.
- **Cause:** `createWebhookDeliveryArchive` selected the whole range with no `LIMIT`, and `replayWebhookDeliveryArchive` looped over every entry of the archive, each inside a single transaction (`apps/api/src/webhooks/archiveReplay.ts`).
- **Breaks:** One admin click could hold a transaction and its locks open for as long as it took to read or insert hundreds of thousands of rows, and build an unbounded JSON document in memory.
- **Fix:** Each call is capped at 500, the same as `replayBatch.ts`. Create returns `nextCursor` (the last archived delivery id, keyset on `created_at, id`) and takes it back as `after`; replay takes `offset` and returns `nextOffset`. Nothing is dropped silently: a caller that ignores the cursor gets a partial archive, and a cursor that is not a delivery of the endpoint is a 404. The response fields that existed are unchanged and `apps/admin` does not call these routes. Test added: 502 deliveries need two calls to archive and two to replay (red on `main`), plus a foreign cursor is rejected.
### Bug: Rebuilding payout trends brings back the pre-MDR fee and net
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** After an admin ran an MDR recalculation, the payout trends page showed the old fee and net payout again as soon as the trends were rebuilt.
- **Cause:** `applyBatchClosed` (`apps/reporting/src/consumer/applyEvent.ts:113`) wrote gross, fee and net from the original `settlement.batch_closed` payload. `recalculate_mdr.go` rewrites `fee_fils` and `net_payout_fils` on the batch row and emits no outbox event, so the payload is stale for every recalculated batch and the rebuild replay restored it.
- **Breaks:** Reporting disagreed with `settlement_batches` and the ledger for any recalculated batch, so a merchant saw a fee and payout that was not what they were charged and paid.
- **Fix:** `applyBatchClosed` now reads gross, fee and net from the `settlement_batches` row it already looks up for status and paid_at, the same source `applySettlementPaid` uses. Test added in `applyEvent.test.ts`: a recalculated batch (fee 300) replayed with a payload fee of 250 records 300; it recorded 250 before. A live trend row stays stale until the next rebuild or `settlement.paid` event, because the recalculation still emits no event. PR: https://github.com/SilentYsf/fils-pay/pull/122
### Bug: A payment link older than the newest 100 cannot be opened or canceled
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** The payment links list pages correctly, but clicking a link older than the merchant's newest 100 opened "Payment link not found". A merchant with an old active link could not see its details or cancel it.
- **Cause:** The API had no merchant-scoped single-link read, so `PaymentLinkDetailPage` fetched the newest 100 links (the list's maximum page) and searched them for the id.
- **Breaks:** An old active link stayed payable and the merchant had no way to cancel it from the dashboard. It was first filed as an improvement because the page admitted its limit; a listed link that cannot be opened is a wrong outcome a user hits, so it is a bug.
- **Fix:** New `GET /v1/merchants/:merchantId/payment-links/:id` (own merchant only, 404 for anyone else's link) and the detail page calls it. Test added: 105 links, two pages with no duplicates or gaps, the oldest opens by id, another merchant gets 404. Red (404) before, green after. The list pager itself needed no change.

### Bug: Captured volume chart shows one point dated the seed day
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** On the seeded live stack, the overview's Captured volume chart showed one point, dated the day the seed ran, although each merchant has dozens to hundreds of captures from February to August.
- **Cause:** The analytics rollups are filled only by replaying `outbox_events`, and reporting dates each capture by its outbox event's time. The seed wrote one sample capture event and one void event per merchant, stamped with the time the seed ran, and none for the March and marketplace captures.
- **Breaks:** The dashboard left out nearly all captured volume and showed the one capture it did count on the wrong day.
- **Fix:** The seed now writes one outbox event per seeded capture and void, stamped with the time that capture or void happened, the same events the API writes. Reporting code is unchanged. Test added in `db/seed/generate.test.ts`.
### Bug: MDR recalculation to a higher rate skips the discount on the fee increase (BHA-194)
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** For a merchant with a negotiated discount, recalculating a closed batch at a higher MDR charged the whole fee increase with no discount. Captures of 600, 200 and 602 fils at 250 bps with a 1000 bps discount, with rebates of 2, 0 and 2 posted, recalculated at 300 bps to a fee of 38 fils instead of 37.
- **Cause:** Since #117 (BHA-183), `recomputeBatchFee` in `recalculate_mdr.go` priced a capture with a `capture: MDR fee` leg at the MDR alone and then subtracted the rebates already posted. Those rebates were computed on the old fee, so the discount share of the increase was never taken off.
- **Breaks:** A discounted merchant was overcharged the discount share of any fee increase applied by recalculation, about a fil per capture at these sizes.
- **Fix:** Every event is now priced with `ComputeSettlementFee` at the new rate, MDR first and then the discount off that fee, the same order as the ledger (#123). The only thing carried over from the ledger is the shortfall between the rebate owed on each posted MDR fee leg and the rebate that actually posted, so a rebate that never posted is still never paid back (#117's guard), and at an unchanged rate the result is the same as before. Test added with the ticket's example: it gave 38 (diff 7) before and gives 37 (diff 6) after.

### Bug: MDR recalculation ignores a merchant's dated fee schedule (BHA-199)
- **Status:** Fixed (fee schedules); the volume-tier half is Found
- **Type:** Money, medium
- **Problem:** For a merchant priced by a fee schedule, running Recalculate MDR with no rate change rewrote closed batches at the merchant's flat rate and posted an adjustment. A 10000 fils capture charged 200 fils at a scheduled 200 bps was recalculated to 250 fils at the flat 250 bps.
- **Cause:** `RecalculateMDR` in `recalculate_mdr.go` read only `merchants.mdr_bps` and priced every event at it, while capture.ts and CloseBatch price each event at `EffectiveMdrBpsAt(schedules, occurredAt, mdr_bps)`, the schedule rate in effect when it happened.
- **Breaks:** Any recalculation over a scheduled merchant charged or refunded fils the merchant was never owed.
- **Fix:** `RecalculateMDR` loads the merchant's fee schedules once with `LoadFeeSchedules`, and `recomputeBatchFee` prices each event at `EffectiveMdrBpsAt` on its own `occurred_at`, the same calls CloseBatch makes. Test added: a scheduled merchant recalculated at an unchanged rate posted a 50 fils adjustment before and posts none after. Still Found: recalculation also ignores the volume-tier bonus, but the tier in effect at capture is not stored and BHA-147 rules out repricing journaled fees at today's tier, so that half needs a decision first.
### Bug: Merchant dashboard shows an expired payment link as active
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** A payment link past its expiry showed "active" in the merchant dashboard (list, detail and the status filter) while the public checkout page said "expired".
- **Cause:** `serializePaymentLink` (`apps/api/src/paymentLinks/serialize.ts:56`) returned the stored `status`, and nothing ever writes `expired` to the row; only the public read derives it from `expires_at`. The list filter (`query.ts`) matched the stored column too.
- **Breaks:** Merchants saw a dead link as live and could not filter expired links; the dashboard and checkout disagreed about the same link.
- **Fix:** The serializer returns `expired` for a stored `active` link past `expires_at`, and the list filter matches the same meaning in SQL (`active` means not yet expired, `expired` means stored active and past expiry); `reserved`, `paid` and `canceled` are unchanged, pagination is unchanged, no schema change. The dashboard gets an `expired` filter and colour. Test added in `routes/paymentLinks.test.ts` (red before: list showed `active`). PR: https://github.com/SilentYsf/fils-pay/pull/132

### Bug: Admin balance adjustments change only the cached balance, not the ledger
- **Status:** Fixed
- **Type:** Money, medium
- **Problem:** A balance adjustment in the admin console moved the merchant's cached balance but wrote no ledger rows, so the next balance rebuild silently undid it and the money never reached a payout. The CSV import posted ledger legs, but no settlement batch ever claimed them, so imported money never reached a payout either.
- **Cause:** `applyBalanceCorrection` in `apps/api/src/admin/balanceAdjustments.ts` updated `merchant_balances` directly, as ADR-0006 asked, while the admin client's comment claimed it posted to the ledger. `CloseBatch` only claimed `merchant_payable` legs of manual credits, so adjustment legs from the import sat unbatched.
- **Breaks:** A correction owed to or by a merchant was never paid or recovered, and it vanished on every rebuild. With the cache now meaning closed but not yet paid out (BHA-189), a cache-only write would also contradict the rebuild.
- **Fix:** Both teams agreed to supersede ADR-0006 with ADR-0008. An adjustment and every CSV import row now post balanced legs (`manual_balance_adjustment_contra` against `merchant_payable`) and never write the cache. `CloseBatch` claims those legs once: a positive adjustment joins gross with no fee, like a manual credit, and a negative one comes off after refunds, oldest first, carrying forward when it would push the batch net below zero. The route keeps its response shape and the console notice says the adjustment reaches the payable at the next close. Test added (`TestCloseBatch_ClaimsManualAdjustmentsOnce`). A positive adjustment above the 50.000 BD credit threshold is refused with `adjustment_needs_second_approver` and goes through the two-approver manual credit flow instead; an import with such a row fails as a whole. Test added (`applyBalanceCorrection rejects a credit above the second-approver threshold`).
- **Deploy steps:** Before deploying, count (read-only) the unbatched `merchant_payable` legs whose entry group has a `manual_balance_adjustment_contra` leg, because the next close pays them; on live this is expected to be 0 (no adjustment imports, empty `admin_audit_log`). Right after deploying and before the first close, run "Rebuild cached balances" once, because live caches still hold the old meaning and credits would otherwise count twice.
### Bug: A wrong login code shows the raw error string `invalid_code`
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** Typing a wrong or expired one-time code on the merchant or admin login showed the text `invalid_code` in the error banner.
- **Cause:** An `AppError` thrown without a message uses its code as the message (`apps/api/src/lib/errors.ts`), so the API answers `{"error":"invalid_code","message":"invalid_code"}`, and `describeError` in both apps' `api/client.ts` showed that message as is.
- **Breaks:** The user saw a developer string instead of being told the code was wrong. The same fallback showed `too_many_attempts` and `resend_too_soon` raw.
- **Fix:** A small code-to-copy map in `describeError` (web and admin), looked up before the API message,, the function every login and dashboard error banner already uses. `invalid_code` now reads "That code is wrong or has expired. Check it and try again."; the two rate-limit codes get a sentence too. Unknown codes still fall through to the code. No test: this is on-screen copy.
### Bug: The acquirer callback signing secret is committed in git
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** `ops/.env.docker` is tracked in git and set `ACQUIRER_CALLBACK_SIGNING_SECRET` to a real value, so anyone with the repo could sign acquirer callbacks for any deployment that kept it.
- **Cause:** The file was committed before `.gitignore` listed it, and an ignore rule has no effect on a file git already tracks. Its own comments claimed it was gitignored and that the committed value was safe to keep; both claims were false, and the "rotated everything again" commit left the value in the tree.
- **Breaks:** A forged callback signed with the committed value passes the signature check and writes a fake fraud-review verdict (cleared or confirmed fraud) onto any transaction's timeline, which support and finance read when deciding on voids and refunds.
- **Fix:** The tracked file now holds an empty placeholder for the secret and true comments, and `ops/README.md` says each host fills in its own copy. The api already reads the secret from the environment and refuses to boot in production without it, so no code changed. The file stays in the tree and history is not rewritten; untracking it and rotating the secret on every host are left to the team.

### Bug: Per-merchant balance rebuild can overwrite a batch close
- **Status:** Fixed
- **Type:** Concurrency, low
- **Problem:** Running `rebuild-balances --merchant` while a batch close or payout for that merchant was in flight could leave the cached balance missing the batch that close just committed.
- **Cause:** `RebuildMerchantBalance` in `apps/settlement/internal/ledger/rebuild.go` ran one upsert with no lock. Its batch sum was read when the statement started, then the upsert waited on the close's row lock and, once the close committed, wrote the old sum over the close's increment. `RebuildAllBalances` already locked the table first; the per-merchant path did not.
- **Breaks:** The displayed balance disagreed with the merchant's closed, unpaid batches until the next rebuild.
- **Fix:** The per-merchant rebuild now runs in a transaction that takes the same `EXCLUSIVE` lock on `merchant_balances` as the full rebuild before it reads the sum, with the same 5 s lock timeout. Test added (`TestRebuildMerchantBalance_KeepsConcurrentClose`), red before the fix (cache 10000, want 10500) and green after.

### Improvement: Capture and new payment link amounts are typed in BHD
- **Type:** UX
- **Before:** The Capture form and the New payment link form asked for "Amount in fils", while the refund form and every displayed amount use BHD. Typing `0.5` into the link form was rejected, and `5` meant 0.005 BHD.
- **Why it shipped:** Money typed in a different unit from the one shown everywhere else invites a 1000x mistake on a form that moves money. The shared string parser `parseBhdToFils` already existed and the refund form already used it.
- **Change:** New `parseBhdAmount` in `apps/web/src/format.ts` wraps that parser (no float maths); `parseRefundAmount` now delegates to it. Both forms label the field "Amount in BHD", placeholder `0.000`, and still send integer `amountFils`, so the API is unchanged: `0.5` is 500, `12` is 12000, `1.250` is 1250. Blank, zero, negatives, a 4th decimal and non-numbers show a plain message. Unit tests added in `apps/web/src/dashboard.test.ts`.
### Bug: Checkout says a payment link does not exist when the API is only busy
- **Status:** Fixed
- **Type:** UX, medium
- **Problem:** When the payment-link lookup failed for any reason (503 from nginx under load, 429, 500, a dropped connection), the buyer saw "Payment link not found. This payment link does not exist." for a link that exists.
- **Cause:** The load handler in `apps/web/src/pages/checkout/CheckoutPage.tsx` caught every error and set the not-found state, without looking at the status code.
- **Breaks:** A buyer could abandon a valid invoice, and the merchant lost the payment, because a page told them something false during a load spike.
- **Fix:** Only an `ApiError` with status 404 shows not found (`loadFailureKind`, the same check `PaymentLinkDetailPage` uses). Any other failure shows "We couldn't load this payment link right now. Please try again." with a Try again button that re-runs the load. `client.ts` reads `import.meta.env?.` so the test can import `ApiError` under node. Test added in `loadFailure.test.ts`. PR: see the PR for this branch.
### Bug: An abandoned payment on an expired link shows the link as payable
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** If a payer started paying and walked away, then the link's expiry passed, the public link page showed it as payable. Pressing pay then failed with an expired-link error.
- **Cause:** `derivePublicStatus` in `apps/api/src/paymentLinks/status.ts` turned a timed-out reservation into `active` without checking `expires_at`, while the pay claim in `pay.ts` requires `expires_at > now`.
- **Breaks:** The payer was invited to pay a link that could no longer be paid.
- **Fix:** A timed-out reservation now reads `expired` when `expires_at` has passed, using the same comparison as the stored `active` branch. A live reservation still reads `processing` past expiry, since its in-flight payment completes. Test added.
### Bug: Transaction and payment-link lists show rows from a previous filter
- **Status:** Fixed
- **Type:** UX, low
- **Problem:** On the transactions list, ticking "captured" while the unfiltered page was still loading showed the captured rows, then the slower unfiltered answer replaced them while the box stayed ticked. The payment links list did the same.
- **Cause:** Each list's `load` ran its setState whenever its request resolved, so an older filter's response that finished last overwrote the newer one. Only the settlement batch list had a guard.
- **Breaks:** A merchant saw rows that did not match the filter on screen, and Load more used the cursor of the wrong filter.
- **Fix:** Both pages now use the request-epoch guard that `SettlementBatchListPage.tsx` already has: the epoch is bumped when the filter changes, and a result or error from an older epoch is dropped. No test: this is a visual race that shows on screen.
### Improvement: A wrong login password reads as a sentence
- **Type:** UX
- **Before:** A wrong merchant id, email or password on the merchant or admin login showed the bare banner `invalid_credentials`, the most common login failure.
- **Why it shipped:** BHA-196 already gave the other login codes a sentence through the same `describeError` map; this one was left raw.
- **Change:** One entry in the error copy map in `apps/web/src/api/client.ts` and `apps/admin/src/api/client.ts`: "Those details do not match an account. Check them and try again." It still never says which field was wrong, the point of the generic code. The two login page comments that said the code is shown verbatim are corrected.
### Bug: Refunds never reach the merchant's daily volume
- **Status:** Fixed
- **Type:** Data, medium
- **Problem:** A merchant who refunded payments saw no refund count or refund total anywhere in the dashboard's daily volume.
- **Cause:** `merchant_daily_volume` had no refund columns, `runConsumerPass.ts` did not list `refund.succeeded`, and the only refund helper (`applyDailySummaryRollup` in `applyEvent.ts`) was never called and keyed its day on the UTC date of the event instead of the Bahrain business day (ADR-0003).
- **Breaks:** Daily volume overstated net business: refunds were invisible to reporting, and the consumer watermark moved past every refund event without recording it.
- **Fix:** Migration `0080` adds `refund_count` and `refund_gross_fils` (additive). The consumer now applies `refund.succeeded` on the Bahrain day of the event, once, through the same watermark as captures. `GET /v1/analytics/volumes` and the Overview table show the two figures. The `refund_merchant_summary` view is left alone: nothing reads it, and fixing its join means dropping a view. After deploy, run a reporting rebuild so refunds made before the migration are counted. Test added in `runConsumerPass.test.ts`.

### Bug: A genuine repeat adjustment CSV with identical rows is never posted
- **Status:** Fixed
- **Type:** Money, low
- **Problem:** Uploading a second, legitimate adjustment file whose rows match an earlier one (the same monthly correction, say) returned the first upload's result and posted nothing.
- **Cause:** #130 (BHA-191) keys the import's idempotency row on a hash of the file's rows per merchant, with no upload id, so identical content was always treated as a resend.
- **Breaks:** A merchant owed a repeated correction was not paid it until someone edited the reason cell to make the file differ.
- **Fix:** The import request takes an optional `repeatUploadId`, sent only when the admin is told the file was already applied and clicks Post again. It gives that deliberate repeat its own idempotency key, so it posts once more through the same threshold check, ledger posting and audit row, while a plain resend, and a resend of the same repeat, still replay. Test added in `adjustmentImport.test.ts`.

### Bug: A flood of new checkouts from one address starves the ones already under way
- **Status:** Fixed
- **Type:** Performance, high
- **Problem:** From one client address at 75 checkouts a second, only 3.3 checkouts a second completed: 2,423 link opens and 1,514 pays of checkouts already started were refused with 429.
- **Cause:** `ops/nginx.conf` counted every api request from an address against one zone, `api_per_ip` (100 a second). A checkout is three requests (create link, open, pay), so new creates used up the allowance and the open and pay of checkouts in progress were turned away.
- **Breaks:** A capacity test driven from one machine sees the stack collapse instead of serving what it can and refusing only the excess.
- **Fix:** Opening a public payment link and paying it now count against their own per-address zone, `checkout_per_ip`, with the same 100 a second and burst of 200; creating new work stays on `api_per_ip`. The in-flight caps from #112 are unchanged and still shed the excess. Rerun of the same load against a local stack: 36.7 checkouts a second completed, no 429, and the excess turned away as 2,225 create 503s with Retry-After. No unit test, because it is config; `nginx -t` passes in the nginx image.
### Bug: Every ledger insert scans the whole ledger
- **Status:** Fixed
- **Type:** Performance, high
- **Problem:** Payment throughput fell as the ledger grew; at 40k to 48k ledger rows a load of 28 to 30 requests per second was served at only 18 to 23 per second.
- **Cause:** The balance trigger `check_ledger_group_balance` (migration `0007`) sums each touched group with `WHERE entry_group_id = ...` on every ledger row written, and `entry_group_id` had no index, so every insert read the whole ledger. Lookups by `transaction_id` on `ledger_entries` (refunds, discount adjustments) and `holds` (capture, void) had no index either.
- **Breaks:** Every capture, refund and adjustment got slower with each row ever written; a capacity run recorded 55,040 sequential scans reading 1.25 billion rows and no index scans.
- **Fix:** Migration `0081` adds three plain indexes, `ledger_entries(entry_group_id)`, `ledger_entries(transaction_id)` and `holds(transaction_id)`, with `CREATE INDEX IF NOT EXISTS` (additive; not CONCURRENTLY because the migrator runs each file in a transaction). The trigger's lookup moves from a Seq Scan to an Index Scan; plans are in the PR. No query or trigger changed.

### Bug: Dev fallback webhook encryption key is the wrong length
- **Status:** Fixed
- **Type:** Deploy, low
- **Problem:** Without an explicit `WEBHOOK_SECRET_ENCRYPTION_KEY`, `loadConfig` threw "must base64-decode to exactly 32 bytes, got 34", so a fresh local start failed.
- **Cause:** The hardcoded dev fallback in `apps/api/src/config.ts` was the base64 of a 34 character phrase, not 32 bytes.
- **Breaks:** Anyone starting the api locally without setting the key could not boot it. Production is unaffected: with `NODE_ENV=production` there is no fallback and the missing key is refused.
- **Fix:** Replaced the dev-only fallback with the base64 of a 32 byte dev-only phrase, same shape. Reproduced by calling `loadConfig` with only `DATABASE_URL` set: it threw before the change and loads a 32 byte key after. No test added, since the existing suites pass an explicit key and a config test file does not exist.

