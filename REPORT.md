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
