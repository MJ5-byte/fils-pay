# FilsPay — what this project is, and what we did

*A plain-English story of the app, the hidden bugs, the riddle, and the feature
we shipped. No technical knowledge needed.*

---

## The app

FilsPay is a real, working money app for Bahrain. Think of it like a tiny bank
that a shop signs up to. A shopping mall sets up an account, gives away a card
terminal (in this project, a checkout page), takes payments in Bahraini Dinar
(BD), and every night FilsPay adds up everything the shop sold, and moves the
money to the shop's account.

The tricky part is *money rules*. Bahraini Dinar has three small units — one
Dinar is one thousand "fils" (like cents, but three of them). So the app never
keeps money as normal decimal numbers; it keeps it as whole fils everywhere. A
small mistake here, like counting a four-instead-of-zero, silently costs people
money.

The whole thing is built like a small company of programs that share one
database:

- an **API** (the front desk) — checkout, logins, issuing refunds, telling shops
  about things;
- a **settlement worker** (the accountant) — does the nightly maths that decides
  who is owed what;
- a **reporting worker** (the analyst) — keeps summaries so dashboards are fast;
- a **merchant dashboard + admin console** (the windows shoppers and staff look
  through).

## The mystery

We were given a repository with a strange history. A developer named Yousif had
left — even his account was deleted — but a commit by him appeared months later.
He had left behind **three hidden messages** (like a treasure hunt), and the
last one was an encrypted box that only opened with the right date.

Decoding the messages told a story:

- **Message 1** (base64): *"Never read the diff. Read it. The next door opens
  with the victim of that rule: five letters, lowercase."* — "the diff" is the
  record of every change to the code.
- **Message 2** (a Vigenère cipher — a technique named after Blaise de
  Vigenère): *"The keeper leaves a note in every commit he writes. Find it.
  ROT THIRTEEN."* ROT13 is a simple secret-language: swap each letter thirteen
  letters forward. Following the notes led to the clue: **the key was a date**.
- **Message 3** (the box): opened with the password **2026-09-28** — the date
  of Yousif's own "ghost" commit. Inside:

> *"The Order of the Prompt is not four people. Every 'Claude says' comment is a
> member and every locked test is a vow."* …and the flag:
> **FLAG{order_of_the_prompt_never_read_the_diff}**

A "flag" like that is how these engineering competitions mark "you solved the
mystery." The message's meaning: the group in the story had a habit of letting
an AI write code, then writing "this is intentional" comments and even changing
the tests so the mistakes would look fine. The bugs we had to find were hiding
inside those comments and those dishonest tests.

## The bugs we found (plain words)

Because of that culture, the app was full of small, dangerous mistakes. We went
through every one and fixed it. The important groups:

- **Money mistakes** — a "-offs CSV" import read amounts **ten times too small**
  (so a shop uploading 4.75 BD actually got credited 0.475 BD); settlement split
  payouts lost a few fils every batch; the night's numbers never quite matched
  the bank's statement because rounding leftovers weren't recorded; recalculating
  a fee could rewrite an *already paid* month.
- **Security holes** — a shop could log in *without* typing the OTP code; a
  merchant could cancel another merchant's payment link; one app could be used
  past its expiry time; payments sent to shops couldn't be verified because the
  electronic signatures didn't match the exact bytes sent.
- **Reliability traps** — the card network's callback could be recorded twice;
  two processes could both send "your payout is on the way"; an empty night could
  accidentally delete the *entire* list of held payments; timezone bugs made the
  daily close run three hours late.
- **The missing feature** — the whole **refund** feature was unwired: the
  endpoint existed but just answered "not built yet." All the helper code was
  there and untested.

For each bug we wrote down *what was wrong, why it happened, and what it broke* —
that write-up is in `docs/EXPLANATIONS.md`.

## What we shipped

1. **All the bugs fixed** with the smallest possible change, proven by tests and
   by running the real app.
2. **Refunds, end to end**: a merchant can now refund a full or partial purchase
   through the API or the dashboard. The money math is verified: the ledgers
   balance exactly to zero fils, the fee taken at sale is reversed correctly, and
   the shop gets a signed webhook ("a refund happened") it can trust. It works
   through the real HTTP surface, the database, and a real delivery.
3. **The whole thing runs**: we added the missing container setup so the entire
   stack boots, and the full test suite is green:
   - `npm test`: **458 / 458 passing** (money, API, reporting, web, scripts)
   - settlement (Go): all tests passing
   - type-checking clean on API, web, admin.

## How to present it

A 5-minute version: *"FilsPay moves Bahraini money. We inherited it hiding a
treasure hunt and two-dozen planted bugs. We decoded the hunt — that's the flag —
then fixed every bug and finished the unfinished refunds feature, proving each
fix by running the real app, and left the whole thing green and deployable."*
Then do the live demo (see `docs/TEACHING.md`) and point at the green test
counts.