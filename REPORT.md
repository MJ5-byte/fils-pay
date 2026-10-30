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
### Bug: KYC PDF-only check trusts the filename, not the file bytes
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** A PNG or JPEG renamed to end in .pdf was accepted as a commercial_registration or bank_letter, and a genuine PDF whose filename did not end in .pdf was wrongly rejected.
- **Cause:** `recordKycDocument` in `apps/api/src/onboarding/kyc.ts:67` decided the PDF-only rule from `input.fileName.toLowerCase().endsWith(".pdf")`, the client-supplied filename, although the real magic-byte type was already detected at `:50`. The module validates from the bytes, never the name (`onboarding/fileSignature.ts:1-6`); the in-code comment claiming `detectFileType` already narrows these document types was false.
- **Breaks:** The PDF-only gate for registry and bank documents: a non-PDF disguised with a .pdf name reached review as a PDF, and a real PDF under a different name was refused.
- **Fix:** The check now compares the detected type (`detected !== "pdf"`), the same string-literal shape the rest of the file uses; the `document_must_be_pdf` error is unchanged. The existing test that asserted the filename behaviour was corrected to accept a real PDF regardless of name, and one test was added for a PNG renamed .pdf being rejected. The upload size limit the ticket worried about is already capped at the boundary (`plugins/multipart.ts` fileSize to 413 in `plugins/errorHandler.ts`), so no size change was needed.
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

### Bug: Bad input on payment-link and transaction routes crashes with 500 or is silently ignored
- **Status:** Fixed (BHA-89, BHA-90, BHA-92, BHA-94, BHA-88)
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
### Bug: Login crashes on a non-UUID merchant id
- **Status:** Fixed (BHA-75)
- **Type:** UX, low
- **Problem:** POST /v1/auth/login with a merchantId that is not UUID-shaped answered 500 instead of a clean 4xx, on an unauthenticated endpoint.
- **Cause:** `routes/auth.ts` passed `merchantId` straight into the login query, where `merchant_id` is a uuid column; a non-uuid value raised Postgres 22P02 (invalid_text_representation), which surfaced as a 500.
- **Breaks:** An unauthenticated endpoint leaked a server error and could not tell bad input from a real failure; every malformed login probe produced an internal error.
- **Fix:** Validate `merchantId` against the repo's shared `UUID_RE` at the route boundary, right after the required-fields check, and answer 400 `invalid_request` before the query, the same shape BHA-91 used for the other id routes. The generic `invalid_credentials` path for a well-formed but unknown merchant is unchanged, so nothing new is disclosed. Test added in `app.test.ts`.

### Bug: Listing API keys has no row limit
- **Status:** Fixed (BHA-78)
- **Type:** Performance, low
- **Problem:** GET /v1/merchants/:merchantId/api-keys ran a SELECT with no LIMIT, so the response grew without bound as a merchant's key count grew.
- **Cause:** `listApiKeys` in `apps/api/src/apiKeys/issue.ts` selected every row for the merchant ordered by created_at, with no LIMIT and no way for the caller to cap the page.
- **Breaks:** A merchant with many keys loaded an arbitrarily large response in a single call.
- **Fix:** `listApiKeys` now clamps a page size the same way every other list query in the repo does (`Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT))`, default 25, max 100) and adds `LIMIT $2`; the route accepts an optional `?limit=` and rejects a non-numeric value with 400, matching BHA-91. The query already selected only the display columns, never key_hash. Test added in `app.test.ts`.
### Bug: Authorize, API key delete and business profile routes crash with 500 on bad input, and profile update builds SQL from request keys
- **Status:** Fixed (BHA-79, BHA-77, BHA-99, BHA-100, BHA-101)
- **Type:** Data, medium
- **Problem:** Authorizing with a negative, fractional, NaN or string amount answered 500, and an amount of 0 went through to the acquirer. Deleting an API key with a non-UUID id, signing up with an unknown business type, and updating the business profile with a null, wrongly typed field or a three-letter country all answered 500. A profile update with an unknown key also answered 500.
- **Cause:** `routes/transactions.ts` passed `amountFils` to `toFils`, which throws RangeError on bad numbers and allows 0. `routes/apiKeys.ts` sent any id to a `uuid` comparison. `routes/businessProfile.ts` checked only that signup fields were present, so the database CHECK, NOT NULL and CHAR(2) constraints failed. `updateBusinessProfile` looked up each request key in `PATCHABLE_COLUMNS` and put the result into the `SET` clause, so an unknown key produced broken SQL instead of being refused.
- **Breaks:** Merchants got internal errors instead of an answer they can act on, a zero-amount authorization could reach the acquirer, and the update query's shape depended on the request body.
- **Fix:** Authorize checks the amount is a positive safe integer before any acquirer call (400 `invalid_amount`). Revoke answers 404 `api_key_not_found` for a non-UUID id, using the repo's `UUID_RE`. `assertValidBusinessProfile` in `onboarding/businessProfile.ts` is shared by signup and update: keys outside `PATCHABLE_COLUMNS` give 400 `unknown_field`, bad values give 400 `invalid_business_profile`, and no input is echoed. Signup now also requires an uppercase two-letter country, and treats a null country as omitted. Tests added in `app.test.ts` and `transactions.test.ts`, including that the acquirer is never called.
### Bug: The transaction date filter and the Run batch default use the UTC day, not the Bahrain business day
- **Status:** Fixed (BHA-139, BHA-142)
- **Type:** Data, medium
- **Problem:** Filtering the merchant transaction list to one day dropped that day's payments made between 00:00 and 03:00 Bahrain time and showed the previous day's 00:00 to 03:00 instead. Between 00:00 and 03:00 Bahrain time the admin Run batch form defaulted to the day before yesterday.
- **Cause:** `dayStartIso` in `apps/web/src/format.ts:35` turned the picked date into UTC midnight (`T00:00:00.000Z`), and a comment above it falsely said it had been switched to Bahrain time. `yesterdayIso` in `apps/admin/src/pages/settlement/SettlementPage.tsx:19` subtracted a day in the browser's zone and then read the date in UTC with `toISOString()`. ADR-0003 keys every daily window on the Asia/Bahrain business day, which starts at 21:00 UTC.
- **Breaks:** A merchant checking one day's payments against that day's settlement batch got a list three hours off, so the two never matched. Near midnight the admin could close the wrong day's batch by accepting the default.
- **Fix:** `dayStartIso` now parses the date at `+03:00`, the same parse apps/api's `bahrainLocalMidnightUtc` uses. The Run batch default moved to `apps/admin/src/pages/settlement/businessDate.ts` and takes yesterday from the Bahrain calendar date, the same technique as apps/api's `todayBahrainDateString`, whatever the browser's zone. The web test that asserted UTC midnight now asserts 21:00Z on the previous day. A new admin test pins both sides of 21:00Z with a fixed clock, and admin gained the same `tsx --test` script the web app has. On a local run, the 27 Aug filter now includes a payment made at 01:03 Bahrain time (22:03Z on 26 Aug) that the old filter left out.

### Bug: The webhook dispatcher double-delivers when more than one replica runs
- **Status:** Fixed (BHA-135)
- **Type:** Concurrency, high
- **Problem:** With more than one api replica running the in-process webhook dispatcher, both replicas selected the same due delivery and both POSTed it, so the merchant received each webhook twice.
- **Cause:** Step B's due-delivery SELECT in `webhooks/dispatcher.ts` (`attemptDueDeliveries`) picked every `pending` row whose `next_attempt_at` had passed with no atomic claim, and the HTTP send happens outside any transaction. Two passes read the same row before either marked it, so both sent. The comments above it ("only ever run ONE api replica", "staging ran 2 replicas, never saw a dup, so it's fine") asserted safety the code never had.
- **Breaks:** Receivers got duplicate `transaction.captured`, `transaction.voided` and `settlement.paid` deliveries, and the `settlement.paid` pre-delivery effect (payout disbursement) could run twice.
- **Fix:** Each delivery is now claimed before it is sent, with a conditional UPDATE that leases the row by pushing `next_attempt_at` past the send window. The row lock serialises two replicas, so exactly one wins each row and the rest skip it. No schema change: the status CHECK constraint has no `sending` value, and `next_attempt_at` already means "not eligible until". A normal attempt still overwrites `next_attempt_at` with the real backoff or sets a terminal status, so the lease only covers the crash-recovery window. Test added: two overlapping dispatch passes deliver one due event exactly once.
### Bug: Transaction authorize crashes with a 500 on an empty or malformed card object
- **Status:** Fixed (BHA-80)
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
### Bug: A NUL byte in a webhook receiver's response stops its delivery from ever being recorded
- **Status:** Fixed (BHA-152)
- **Type:** Concurrency, medium
- **Problem:** A receiver that answered with a body containing a NUL character (any status code) made its delivery retry on every dispatcher pass forever: the attempt count and status never changed, so the delivery never reached `exhausted`, and the webhook log showed no attempt.
- **Cause:** `attemptOneDelivery` (`apps/api/src/webhooks/dispatcher.ts:180`) passed the raw receiver body into `response_body_excerpt`, and Postgres TEXT rejects NUL. The query threw before the UPDATE applied, and the per-row catch in `attemptDueDeliveries` leaves the row untouched.
- **Breaks:** A receiver controls whether its own delivery ever progresses or backs off, and it adds a failing query to every pass, with an error log line each time.
- **Fix:** One `replaceAll` strips NUL from the body before the three UPDATEs that share it; the 2000-character cap is unchanged. PR: https://github.com/SilentYsf/fils-pay/pull/72. Tests added in `dispatcher.test.ts` for a 200 and a 500 response, which also check that another endpoint is still delivered.

### Bug: Admin audit rows for settlement re-run, balance rebuild and MDR recalculation say "succeeded" before the action has run
- **Status:** Fixed (BHA-153)
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
### Bug: Merchant login cookie expires after 10 minutes even though the session lasts 12 hours
- **Status:** Fixed
- **Type:** Security, medium
- **Problem:** After a merchant passed the OTP step, the browser dropped the session cookie about 10 minutes after login, so the merchant was logged out long before the session's 12 hours.
- **Cause:** `POST /v1/auth/login` sets the cookie with the pending maxAge (10 minutes), and `/otp/verify` (`apps/api/src/routes/auth.ts:199`) promoted the session on the server but never re-issued the cookie. The admin verify (`adminAuth.ts:217`) already does.
- **Breaks:** Merchants were signed out mid-work, and the server-side session TTL setting had no effect on how long a login really lasted.
- **Fix:** `/otp/verify` now re-sets the same cookie with `sessionTtlHours * 3600` after a successful verify, mirroring the admin flow. Test added in `routes/auth.test.ts`. PR: https://github.com/SilentYsf/fils-pay/pull/81.

### Bug: A KYC document with an Arabic filename cannot be downloaded
- **Status:** Fixed (BHA-64)
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

### Bug: Scheme export amount overflows on a large capture
- **Status:** Fixed (BHA-158)
- **Type:** Data, medium
- **Problem:** Closing a settlement batch that holds a large capture (BD value past eight integer digits, e.g. 100,000,000.00 BD) failed outright: the whole CloseBatch transaction aborted with a numeric field overflow, so the batch never closed.
- **Cause:** CloseBatch wrote a second, denormalised copy of the line amount into `scheme_export_lines.amount`, a `NUMERIC(10,2)` column (migration 0050), via `SchemeAmountBD`, a `float64(grossFils)/1000.0`. Fils are `BIGINT` everywhere (ADR-0001), and a large fils value does not fit `NUMERIC(10,2)`, so Postgres rejected the insert. The durable record, `amount_fils` (`BIGINT`), never overflows, and the export reader already preferred that column via COALESCE.
- **Breaks:** No batch containing a large capture could be closed; settlement stalled for that merchant and day. The float copy also disagreed with `amount_fils` by up to 9 fils (it rounded the untruncated gross), against ADR-0002's "amount must be exactly amount_fils / 1000 formatted to two decimals".
- **Fix:** Stop writing the overflow-prone float column at close (it is nullable and no reader needs it) and format the exported BD figure from the `BIGINT` `amount_fils` with the existing `formatFilsAsTwoDecimalString`, which is exact and cannot overflow. Removed the now-unused `SchemeAmountBD` float helper. No schema change. Test added: a 100,000,000.00 BD capture now closes and exports "100000000.00".
