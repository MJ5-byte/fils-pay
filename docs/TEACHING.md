# FilsPay — sit-down walkthrough + run-it-yourself (teaching script)

*For the senior teammate. Use this to teach the junior teammate (and to have*
*them run the app) in one or two unhurried sessions, without overwhelming.*

## How to use this sheet

- **Go slowly. One big idea at a time.** Each block below is a single concept:
  read the "Say this" line, then the "analogy", then the ⏸ check.
- At the ⏸ you ask one easy question; if the answer is off, don't move on — re-tell
  the same idea a simpler way (the "if lost" line) and try again.
- Don't read this document to them. It's your script; they hear *you*.
- The demo at the end is the real proof — run it together, don't just describe it.
- If they get the whole thing in one sitting, great; otherwise the natural
  breakpoints are marked **⏸ SESSION 2** so you can stop cleanly.

---

## Part 1 — The app in one sentence

- **Say this:** "FilsPay is a *money-moving app*. A shop takes card payments in
  Bahraini Dinar, FilsPay keeps the books, and every night it pays each shop what
  it's owed."
- **Analogy:** "It's a mini-bank that only does one job: take a sale's money, hold
  it safely, then hand it to the right shop at the end of the day."
- ⏸ *"What does FilsPay do at the end of every day?"* → hands the shops their money.
- **If lost:** "Shop sells something → FilsPay gets the money → FilsPay gives the
  shop its cut later."

## Part 2 — Money rules (the most important idea)

- **Say this:** "Bahraini Dinar isn't 100 parts, it's **1000** parts: one Dinar is
  one thousand *fils*. So real money numbers look like 4.750 BD. Because money is
  that fine, the app **never uses normal decimal arithmetic** — it keeps
  everything as whole *fils* (4.750 BD = 4750 fils) and only splits into Dinar for
  display."
- **Analogy:** "Like a waiter who only ever counts coins, never writes 4.75 as a
  floating number — because a 0.005 rounding could lose a real fils, and a fils is
  a real coin."
- ⏸ *"How many fils are in one BD?"* → 1000. *"Is 4.75 BD stored as the number
  4.75?"* → No, as 4750 fils.
- **If lost:** "Think: money is coins, never fractions. Three small units per
  Dinar."

## Part 3 — The four programs (one job each)

| Program | Its job | The everyday name |
|---|---|---|
| API | talks to the outside world (checkouts, logins, refunds, webhooks) | the front desk |
| Settlement worker (Go) | does the nightly maths: who is owed what | the accountant |
| Reporting worker | keeps summaries so dashboards are fast | the analyst |
| Merchant dashboard + admin | windows shoppers and staff look through | the screens |

- **Say this:** "They're four programs sharing **one database**. When something
  happens, the front desk writes it to the shared notebook; the accountant reads
  it and does the money; the analyst keeps it summarized."
- ⏸ *"Do the programs talk to each other directly, or through the notebook?"* →
  Through the notebook (the database).
- **If lost:** "One team, one room, one notebook — the accountant and analyst
  read what the front desk wrote."

## Part 4 — A purchase, step by step (the money is the point)

Walk them through a single card payment:

1. **Authorize** — the card is checked; the money is *held aside* but not taken.
   *(analogy: a restaurant "pre-authorizes" your card before the meal.)*
2. **Capture** — the shop decides how much to actually take; FilsPay:
   - records the gross amount,
   - takes its **fee** (a small percentage of each sale — called the MDR),
   - records that it owes the merchant the rest,
   - and, because money is sacred, writes **both sides of every move** (this is
     "double-entry bookkeeping": if money goes in one pocket it comes out of
     another). If both sides don't balance to zero, the write is refused.
3. **Settle** — end of day, everything captured today is added up → the shop's
   balance → the payout is scheduled.
4. **Refund** — the shop gives money back: FilsPay returns the amount **and**
   reverses the fee it took, again both-sides-balance.
5. **Notify** — FilsPay tells the shop "your refund happened" via a *webhook*.

- ⏸ *"What are the two sides that must balance?"* → Money in / money out, same
  amount.
- **If lost:** "It's a bank balance sheet: every move is two entries that net to
  zero."

## Part 5 — Webhooks & the outbox (one breath)

- **Say this:** "A webhook is the app *calling you* on the internet when
  something happens — 'your shop got paid', 'a refund happened'. To prove it's
  really FilsPay, it signs the message with a secret handshake; to be reliable,
  it writes its messages to a *to-do list* in the database (the **outbox**) so
  nothing is lost even if it crashes mid-way."
- **Analogy:** "Like a postman who writes down every letter in a register before
  delivering — if the van breaks down, the letters aren't lost."
- ⏸ *"Why does the app sign a webhook?"* → So the shop can trust it's really from
  FilsPay.
- **If lost:** "To-do list + secret handshake = reliable, safe notifications."

## Part 6 — The mystery & the bugs (the story we're presenting)

- **Say this:** "The app we inherited had a strange past: a developer's account
  was deleted, but a change under his name appeared months later, and he left
  **three hidden messages**. We decoded them — it's a code-cracking trail that
  ends in a flag, like a medal:
  **FLAG{order_of_the_prompt_never_read_the_diff}**."
- **Say this:** "The trail taught us *why* there were two dozen bugs: the original
  team would let an AI write code and then write comments and even *tests* making
  the mistakes look correct. So we couldn't trust the tests; we had to read what
  the code really did."
- ⏸ *"What does the flag tell us about why the bugs existed?"* → people covered
  up mistakes with comments and dishonest tests.
- **If lost:** "People hid mistakes; we found them by checking what the code
  *actually* does."

## Part 7 — The feature we shipped (refunds)

- **Say this:** "The app was *missing* refunds — the endpoint just said 'not
  built yet'. We finished it end to end: a merchant can refund a full or partial
  purchase, the money math stays perfectly balanced, the fee is reversed
  correctly, and the shop gets a signed webhook telling it a refund happened."
- ⏸ *"Name the three things our refund feature must get right."* → the money
  balances, the fee reversed, the shop told. 

**⏸ SESSION 2 (natural stop):** everything above is the conceptual core. Next is
hands-on — run the app together. If it's a second sitting, re-ask the ⏸ checks
in 30 seconds each before running.

---

## Part 8 — Run it yourself (hands-on, with the senior)

### The one breath about git (only if needed)
- **Say this:** "Git is just how programmers share code. This project's code
  lives on GitHub; 'pulling' means downloading the latest copy to your machine.
  One command gets us the code: `git pull`. You don't need to know more than that
  today."

### Prereqs (do this check first)
```bash
node --version && npm --version && go version   # all three should print versions
docker --version && docker ps                    # docker running (or skip to Local)
```
If anything is missing, install it before the session.

### Option A — the container stack (one command each)
```bash
docker compose -f ops/docker-compose.yml up -d postgres      # start the database
docker compose -f ops/docker-compose.yml run --rm migrate    # build the schema
docker compose -f ops/docker-compose.yml run --rm seed       # demo data
docker compose -f ops/docker-compose.yml up api settlement reporting   # the three services
```
Then the API is at `http://localhost:3000`, settlement internal on `:8091`,
reporting running as a worker, postgres on `:5432`.

### Option B — local (npm) path
```bash
npm ci
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable'
export WEBHOOK_SECRET_ENCRYPTION_KEY='Z0LL0dYoE7tlS6KcO9dkXxybccIIK1Y/CB9H/DBlgKM='
npm run migrate
npm run seed
npm -w apps/api run dev        # API on :3000
# separate terminal:
cd apps/settlement && go build ./... && ./settlement daemon
# separate terminal:
npm -w apps/reporting run dev
```
*`Z0LL…` is the sandbox development webhook key kept in `ops/.env.docker`; in a
real deploy you rotate it.*

### The 2-minute demo (the "money moved correctly" proof)
Run this against the running API (`curl` is preinstalled). Replace `$KEY` with a
seed key — the seed prints them, e.g. `fp_live_Lh_8Og9-UuZDQkmbJ8CQ7m4aRT-7Pez1`
(from `ops`, or scroll the seed output).

```bash
API=http://localhost:3000
KEY=fp_live_Lh_8Og9-UuZDQkmbJ8CQ7m4aRT-7Pez1
H=(-H "Authorization: Bearer $KEY" -H 'content-type: application/json')

# 1. take a payment (authorize) -> returns an id
curl -s -X POST $API/v1/transactions -H "${H[@]}" \
  -H 'idempotency-key: demo-auth' \
  -d '{"amountFils":20000,"card":{"pan":"4242424242424242","expiryMonth":12,"expiryYear":2030,"cvv":"123"},"reference":"demo"}'

# 2. capture it (take the money + fee)
curl -s -X POST $API/v1/transactions/<THE_ID>/capture -H "${H[@]}" -H 'idempotency-key: demo-cap' -d '{}'

# 3. refund 8000 fils of it (partial refund)
curl -s -X POST $API/v1/refunds -H "${H[@]}" -H 'idempotency-key: demo-ref' \
  -d '{"transactionId":"<THE_ID>","amountFils":8000}'
```

**What to point at in the response:** the refund `status: "succeeded"`, the
`transactionStatus: "partially_refunded"`, the `feeReversedFils` (the fee taken
at capture reversed proportionally), and that it came back as one clean JSON
object — same shape the webhook carries.

Then the database truth (balance check):
```bash
psql "$DATABASE_URL" -c "SELECT status, refunded_fils FROM transactions WHERE id='<THE_ID>';"
```
`status` = `partially_refunded`, `refunded_fils` = `8000`. And the money stays
perfectly split because the ledger requires every group to sum to zero.

### The full test suite (the "we proved it" numbers)
```bash
npm test                   # all workspaces -> we ship 458/458 passing
cd apps/settlement && go test ./...    # settlement green
```
Run these in front of them once, then say: *"Those green numbers exist because we
fixed each bug with a test that would catch it again."*

---

## The five "how to check they actually got it" questions

Use these to end — if they can answer three of five, they own the app:

1. *How many fils are in one Dinar, and how does FilsPay store money?*
2. *What does "double-entry" mean and why does it stop bugs?*
3. *What does the settlement worker do at the end of every day?*
4. *What is a webhook, and why is it signed?*
5. *What did we actually build and prove?*

Full answers are in `docs/ENGINEERING.md`; the bug-by-bug story is in
`docs/EXPLANATIONS.md`.