# FilsPay bugs, explained simply

This is the plain-language version of [BUGS.md](BUGS.md). Each bug keeps the
same number in both files, so you can look up the technical details there.

**Total: 57 items** · ✅ 24 fixed · 🔴 15 confirmed, not fixed · ❓ 14 suspected · 🟡 1 worked around · ➖ 3 not a bug

Each heading starts with a running count (1, 2, 3 …). The number in brackets at the end, like (#15), is the bug's ID in [BUGS.md](BUGS.md); IDs were given in the order bugs were found, so they aren't in sequence.

**Status:** ✅ fixed · 🔴 confirmed, not fixed yet · ❓ suspected, not confirmed yet · ➖ checked, not a bug

## How sure are we?

- **Proven** — we made it happen on the running app or ran the code: #1, #3, #4, #15, #17, #19, #45, #28, #34, #36, #38, #39, #40.
- **Confirmed in the code** — we traced it line by line against the rules, but haven't made it happen yet: most other 🔴 items.
- **Failing test, cause unknown** — #37, #42: something is wrong, but it could be the test rather than the app.
- **❓ suspected** — plausible but not proven; may turn out to be nothing.
- **➖ not a bug** — we checked and it was fine. Some "bugs" in this repo are deliberate decoys.

## A few words first

- **FilsPay** is a card-payment company in Bahrain. Shops ("merchants") use it
  to take card payments, and FilsPay pays the money out to them.
- **BD and fils:** 1 Bahraini dinar (BD) = **1000 fils**. Many bugs here come
  from code treating it as 100, like dollars and cents.
- **Merchant dashboard:** the website shops use to see their own payments.
- **Admin console:** the website FilsPay staff use to run everything.
- **Ledger:** the official record of every money movement. If anything
  disagrees with the ledger, the ledger is right.
- **Settlement / payout:** each day FilsPay adds up a shop's sales, takes its
  fee, and pays the rest to the shop.
- **Scheme file:** the daily file sent to Visa/Mastercard listing the payments.
- **OTP:** the one-time code you type after your password.

---

## Money calculated wrong

### 1. ✅ Imported corrections were 10 times too small (#1)
Finance uploads spreadsheets of manual corrections. The system read "4.75 BD"
as 0.475 BD, because it assumed 100 fils per dinar instead of 1000. It also
quietly dropped a third decimal (4.755 became 4.750).
**Fixed:** amounts are now read correctly, and anything with too many decimals
is rejected instead of silently cut.

### 2. ✅ Promotional discounts were 10 times too small (#35)
Same mistake as #1, in a different place. It also accepted nonsense like
"4.75abc".
**Fixed** the same way.

### 3. ❓ The same correction file can be imported twice (#2)
If someone double-clicks Import, every correction is applied twice. This already happened once in August. Strictly this is a missing safety feature rather than broken code.
already happened once in August.

### 4. ✅ The daily Visa/Mastercard file rounds amounts up instead of down (#3)
The rules say amounts must be cut down to 2 decimals (4.745 → 4.74). The
code rounded instead (4.745 → 4.75). So the file always claimed slightly more
than the real total. This is why the card network's statement was "always a
few fils higher" (finance memo, item 1). People blamed Visa for this; it was
our file.
**Proven:** in the local data, 7 lines were too high and none were too low.
**Fixed:** the file now uses the cut-down amount, and the database refuses any
new line where the two figures disagree. The 7 old lines were left as they are,
because they're what was actually sent; finance needs to book that 70 fils
difference.

### 5. ✅ Payouts use imprecise maths (#4)
The payout amount is calculated with a low-precision number type. On large
batches the shop gets paid 1 fils too little. Example: Delta Wholesale's batch
of 20,000.123 BD. The "lifetime payout estimate" drifts for the same reason.
**Fixed:** payouts and the lifetime estimate now use exact whole-fils maths.

### 6. ✅ Fee recalculation changes payouts that were already paid (#6)
"Recalculate MDR" is supposed to post a correction for the future. Instead it
also rewrites the numbers on batches that were already paid, so the records
no longer match what was actually sent to the bank.
**Fixed:** paid batches are never changed now; the correction is still recorded separately in the ledger.

### 7. ✅ Split payouts lose a few fils every time (#43)
Some marketplaces split each payout between several sub-shops. Each share is
rounded on its own, and the leftover fils are never paid to anyone, yet the
payout is marked as complete. A few tens of fils go missing every batch.
**Fixed:** the leftover fils now go to the largest share, so the parts always add up to the whole. Payouts are refused if the shares don't add up to 100%.

### 8. ✅ The dashboard shows a different fee from the one charged (#44)
The dashboard shows the most recently *typed-in* fee row, but billing uses the
row that is actually *in effect today*. After a backdated correction, a shop
could see 2.45% while being charged 2.25%.
**Fixed:** the dashboard now shows the rate actually in effect, worked out the same way billing does.

### 9. ✅ Shops can refund more than they were paid (#46)
If a shop authorised 10 BD but only collected 4 BD, the system still allows a
refund of the full 10 BD. That means 6 BD leaves FilsPay that was never
received.
**Fixed:** the limit is now what was actually collected. Tested: 10 BD authorised, 4 BD collected → a 10 BD refund is refused.

### 10. ✅ Two refunds at the same moment can both go through (#50)
If two refund requests for the same payment arrive at the same time, both
check the "already refunded" total before either has saved, so both pass and
both send money back. Normal payments lock the record while they work;
refunds don't. (Ticket FP-209.) Refunds aren't switched on yet, so this
would bite as soon as they are.
**Fixed:** the payment is locked and the refund amount reserved before the bank is asked, so a second request at the same moment is refused. Tested: two 6 BD refunds on a 10 BD payment → one goes through, one is refused.

### 11. ✅ A shop could refund another shop's payment (#51)
The refund code finds the payment by its ID only and never checks it belongs
to the shop asking. Like #50, this is waiting to go live when refunds are
switched on.
**Fixed:** refunds only find payments belonging to the shop asking. Tested both directly and through the API.

### 12. ✅ The reconciliation check guessed fees instead of using the real ones (#55)
Reconciliation compares the ledger with what's waiting to be paid out. It
re-guessed each payment's fee from the shop's standard rate, ignoring special
negotiated rates, and it left out refunds. For Alpha it showed a 25 fils gap
that wasn't real.
**Fixed:** it now uses the fee actually charged on each payment and includes
refunds. Checked on the live app: the gap is 0.

### 13. ✅ Partial refunds might return slightly too much fee (#5)
Each partial refund rounds its fee on its own. Over several partial refunds,
the total fee returned might add up to more than the original fee.
**Fixed:** the fee given back is worked out on the running total, so it always adds up to exactly the fee charged. Tested: a 3 fils fee refunded in two halves gives back 3, not 4. Discounts are taken into account too.

### 14. ❓ The settlement summary may double-count some sales (#7)
For shops that collect one order in several parts, the summary shows about
38% more than the actual batches.

### 15. ❓ One fee calculator rounds differently from the rest (#8)
One partner-facing fee calculator rounds half-up, while the rules say
"half-to-even" (banker's rounding).

---

## Balances shown wrong

### 16. ✅ The "Rebuild cached balances" button sets balances to wrong numbers (#15)
This button is supposed to recalculate what FilsPay owes each shop. Instead of
using the ledger, it adds up every card payment the shop ever had, ignoring
fees, payouts and refunds. The command-line version of the same tool does it
correctly.
**We reproduced it:** Alpha Retail is really owed **136,496 BD**, but the button
shows **7,326 BD** ("135K went to 7K", finance memo). Delta Marketplace is owed
22,677 BD, but the button shows **0**.
**Fixed:** the button now uses the ledger, exactly like the command-line tool. Checked on the live app: Alpha stays at 136,496 BD.

### 17. ❓ "Adjust balance" hides problems (#16)
Support can type in a new balance by hand without any ledger record. This is
how the wrong numbers from #15 kept getting "fixed" by hand and never
investigated.

### 18. ✅ A button quietly turns test shops into real shops (#17)
"Recompute transaction statuses" switches off a shop's test mode without
asking. Test shops (like Gamma) then get included in real daily payouts.
**Fixed:** recomputing statuses no longer touches test mode. Tested: a test shop stays a test shop.

---

### 19. ✅ The dashboard couldn't show how much had been refunded (#58)
The payment details never included the refunded amount (a code comment
claimed they did), so the dashboard couldn't tell how much could still be
refunded.
**Fixed:** the refunded amount is now sent and shown on the payment page.

## Card payments and payment links

### 20. 🔴 A payment link can be paid twice (#9)
A payment link should only work once. If the first customer's card takes
longer than 60 seconds, the link opens up again and a second customer can pay
too. This caused the May incident, which was wrongly blamed on duplicate
messages from the bank.

### 21. 🔴 Nothing stops a second payment on the same link (#10)
The safety rule "one successful payment per link" was marked as done but was
never actually added.

### 22. 🔴 Messages from the bank aren't de-duplicated (#11)
If the bank sends the same notification twice, FilsPay records it twice. A
"fix" for this was announced in May but doesn't exist.

### 23. ✅ One shop can cancel another shop's payment link (#45)
A shop can cancel any payment link on the platform if it knows the link's ID,
even links that belong to a different shop.
**Fixed:** a shop can now only cancel its own links. Tested: the other shop gets "not found" and the link stays active.

### 24. 🔴 Expired payment links can still be paid (#48)
The payment page trusts the time the customer's device says it is. Anyone can
claim it's an earlier date and pay a link that has already expired.
A real customer reported exactly this (ticket FP-187). The design documents allow it for offline card terminals, but the public payment page lets anyone use it.

### 25. ❓ Card holds may come back after being cancelled (#12)
A "hold" reserves money on a customer's card. After a cancellation, some holds
were seen switching back to active.

### 26. ❓ Reusing a request ID on a different payment isn't blocked (#13)
The API should reject the same request ID being used for a different
transaction. This isn't tested and may not be enforced.

### 27. ❓ The public refund API isn't connected (#32)
The refund API answers "not implemented".

### 28. ✅ Refunds crashed if no reason was given (#36)
**Fixed:** a missing reason is now saved as "unspecified".

---

## Security

### 29. ✅ You could log in without the OTP code (#39)
Typing just the password was enough to use the merchant API. The second step
did nothing.
**Fixed and tested on the live app:** password only is now refused, and
password plus code works.

### 30. ✅ Secret codes were guessable (#21)
OTP codes, payment link addresses and admin invite codes were made with a
predictable random generator.
**Fixed:** they now use a secure generator.

### 31. ✅ "View as merchant" gave staff full control (#22)
When FilsPay staff viewed a shop's account, senior staff got full owner rights
instead of read-only access. Staff who had been disabled could keep using it.
**Fixed:** it is always read-only now, and disabled staff are blocked.

### 32. 🔴 Anyone can send fake fraud reports (#34)
The bank sends signed "fraud review" messages. FilsPay accepts messages
**with no signature at all**.
**We proved it:** a made-up "confirmed fraud" message on an Alpha Retail
payment was accepted and saved. Old signed messages can also be re-sent
forever.

### 33. 🔴 Replaced API keys keep working (#47)
When staff "rotate" a shop's API key, a new key is created but the old one is
never switched off. Every key ever rotated still works.

### 34. 🔴 Staff can approve their own large credits (#25)
Big credits need a second person to approve them. The system checks this by
comparing *display names* instead of user IDs. The size check also ignores
part of the amount, so some large credits skip approval entirely.

### 35. 🔴 A secret key is saved in the code repository (#26)
A real signing secret was committed to the code where anyone with access can
read it.

### 36. ❓ Error codes reveal that other shops' data exists (#23)
Asking for another shop's data returns "forbidden" instead of "not found",
which confirms the item exists.

### 37. ❓ Disabled shop users might still be able to log in (#41)
The login check doesn't verify that the shop user is still active.

### 38. ❓ API keys skip all role checks (#49)
An API key can do things that only the shop owner should be able to do. Also,
when staff act on a shop's behalf, the records can't tell staff from the shop.

### 39. ➖ The admin login cookie is set twice (#24)
Suspected to be a security problem. Checked: the second time just extends how long the login lasts, and admin logins do require the code. Not a bug.

### 40. ❓ The OTP code can be retried a lot by asking for new codes (#53)
Each "resend code" gives a fresh set of guesses, every 30 seconds, with no
overall limit. The chance of guessing is small, but there's no cap.

---

## Timing and dates

### 41. ✅ The daily payout runs at 3 a.m. instead of just after midnight (#20)
The scheduler uses UK/UTC time to decide what "today" is, so it runs about 3
hours late in Bahrain.
**Fixed:** the scheduler now uses Bahrain time, so the close runs just after midnight.

### 42. ✅ The March clean-up script is unsafe to run (#19)
- **Running it twice applies it twice.** It has no way to tell it already ran
  (finance saw the gap double on staging), and it has no "test run" mode.
- **It uses the wrong month boundaries:** UTC instead of Bahrain time.
- **It charges the shop** for the rounding leftovers instead of recording them
  in FilsPay's own suspense account.
**Fixed:** it only does a test run unless told `--apply`, refuses to run a second time, uses Bahrain months, and records leftovers in FilsPay's own accounts instead of charging the shop. Tested: the second run said "already posted, nothing done".

### 43. ➖ Analytics dates were suspected to be off by one day (#18)
Checked: the date calculation is actually correct.

---

## Webhooks (automatic notifications to shops)

### 44. 🔴 Webhook signatures don't match the message sent (#14)
FilsPay signs each notification so shops can trust it, but it signs one copy
of the message and sends a separately-built copy. If the two differ, the
shop's check fails. A fix existed on Yousif's deleted branch `ya/sign-raw`.

### 45. 🔴 Shops get two "your payout is on the way" messages (#52)
Two parts of the system can check "has this payout been announced yet?" at
the same moment, both see "no", and both send the message. A promised
safety lock for exactly this was marked as done but was never built.
(Incident 2026-08-21.)

### 46. 🔴 The webhook retry timing test fails (#37)
The automatic retry schedule doesn't behave as its test expects.

---

## Running the system

### 47. 🔴 Database errors can hide the real problem (#27)
If undoing a failed database change also fails, the original error is lost.

### 48. 🔴 The app won't start without extra setup (#28)
The built-in development encryption key is the wrong length, so the API
crashes on start-up unless you provide your own key.

### 49. 🔴 The Docker setup is incomplete (#29)
Two build files that the setup needs are missing, so the services can't be
started with Docker.

### 50. 🔴 Exporting transactions loads everything into memory at once (#33)
The release notes say the export streams data bit by bit; it doesn't. Big
exports can crash the server.

### 51. 🟡 The websites couldn't talk to the API (#38)
The API doesn't allow the dashboards' web addresses to call it, although a
code comment claims it does.
**Worked around** for local use with a dev proxy.

### 52. ✅ The hold clean-up script could delete every hold (#40)
On a night with nothing to clean up, the script would delete **all** card
holds. It also deleted holds instead of marking them expired.
**Fixed:** it now only marks old holds as expired, in one safe step.

### 53. ➖ The reporting service writes rows with no shop attached (#42)
The analytics service saves some figures without saying which shop they belong
to, so they fail to save.
**Checked: not an app bug.** Another set of tests leaves fake, empty records in the shared test database, and the reporting tests trip over them. On a clean database they pass.

### 54. ✅ Reports couldn't record refunds at all (#56)
The reports table had nowhere to store refunds, the half-written code listened
for the wrong message name and used the wrong day, and the admin refund summary
matched refunds to payments by the wrong ID, so it was always empty.
**Fixed:** refunds are now counted on the right Bahrain day, and the summary is
rebuilt correctly. (Nothing refreshes that summary automatically yet.)

### 55. ❓ One bad record can stop the reports updating forever (#57)
If the reporting service meets a broken record, it retries it again and again
and never moves on, so every later sale and refund is missing from the reports.
We saw this happen locally.

### 56. ❓ The reporting service may leak database connections (#30)

### 57. ❓ Two fee rows with the same start date aren't prevented (#31)

---

## The unfinished feature (ticket FP-300): refunds

The last developer started **refunds** (giving a customer their money back)
and never finished. **Status: built and working end to end, except hosting.**

- **Asking for a refund:** shops can now refund a payment through the API and
  from a button on the payment page.
- **Money is right to the fils:** we fixed refunding more than was charged (#46),
  two refunds at once (#50), refunding another shop's payment (#51) and fee
  rounding on partial refunds (#5). In a live test, refunding 4 BD of a 10 BD
  payment gave back 90 fils of the 225 fils fee, exactly 40%.
- **Payouts:** the daily payout now subtracts refunds. (If a day's refunds are
  bigger than its sales, that day pays nothing and the difference isn't carried
  over yet; the ledger still shows the right balance.)
- **Shops are told:** the "refund succeeded" notification is sent; we received
  it on a test endpoint.
- **Timeline, reports and reconciliation** all show the refund; reconciliation
  matched to the fils.
- **Hosting on "Dilmune Cloud":** not started yet. We need the details from the
  organisers.

---

## What we learned along the way

- **Several "rules" files in the repo can't be trusted.** CLAUDE.md,
  AGENTS.md, .cursorrules and the CHANGELOG say things that aren't true (for
  example "1 BD = 100 fils", "never change a test", and fixes that never
  happened). The architecture document and design records are the real rules.
- **Many bugs were explained away rather than fixed.** Comments like "Claude
  says it's fine" or "this is intentional" usually sit right on top of a real
  bug.
- **The support ticket sheet (29 Oct 2026)** is matched to bug numbers at the bottom of [BUGS.md](BUGS.md).
- **The finance memo of 20 Sept 2026** lists 12 problems; each one is matched
  to a bug number in [BUGS.md](BUGS.md).
- **Test data:** running the automated tests adds hundreds of fake shops to the
  local database. `npm run seed` resets it.
