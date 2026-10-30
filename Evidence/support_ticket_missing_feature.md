# FilsPay Case File - Support Tickets & Missing Feature

---

## Document 1: Support Ticket Excerpts & Incident Notes

**Header Info:**
* **System:** FilsPay (THE HANDOVER / CASE FILE)
* **Evidence Metadata:**
  * CASE NO.: `000`
  * ITEM: `03`
  * COLLECTED: `29.10.26`
* **Prepared By:** [Redacted]
* **Source:** [Redacted]

---

### Ticket Excerpts

#### `FP-187` | Payment link paid after expiry
A buyer says the link showed "expired", but the payment still went through. The checkout page sends something that the server shouldn't trust. Engineering flagged this months ago.

---

#### `FP-201` | Duplicate notes on acquirer callbacks
* **Stamp:** `REOPENED` *(Red stamp on left)*
* **Details:** The bank sent the same callback twice <ins>and we</ins> saved two identical notes on one payment. The 1.9.0 postmortem says this was fixed. **((It wasn't.))** *(Note: "It wasn't." is circled in red ink)*

---

#### `FP-203` | Balance cache wrong after admin action
An admin clicked "Recalculate cached balances" and a merchant's balance dropped from 135K to 7K. The CLI tool gives the right number. The two read from different places.

---

#### `FP-209` | Concurrent refund: double money out
Two refund requests came in at the same time. Both went through, and we lost money. Normal payments don't have this problem. So why do refunds?

---

#### `FP-240` | Webhook signatures rejected by merchants
Some merchants can't verify our webhook signatures. The part that signs the message and the part that sends it don't agree on what it looks like. Also, someone said the incoming signature check has its own problems.

---

#### `INCIDENT 2026-05-14` | Payment link charged twice
A slow payment let a second buyer use the same link before the first one finished. Both were charged. The code comments say 'this IS reachable.'

---

#### `INCIDENT 2026-08-21` | Duplicate payout notifications
Shops got two "your payout is on the way" messages for the same payout. Two processes checked at the same time, and both thought they were first.

---

### Handwritten Note Section

> **_things that feel wrong but nobody's filed tickets for:_**
> - *can you refund more than what was actually charged?*
> - *the settlement splits are always a few fils short*
> - *some admin actions don't seem to have the right role checks*
> - *there's a key rotation flow that doesn't do what you'd expect*
> - *the daily close timing doesn't match what the docs say*
> - *one of the reporting queries is suspiciously slow*
> - *what happens to test merchants when certain admin tools run?*
> - *the OTP implementation changed at some point. is it still safe?*
> - *has anyone tried uploading a really large export?*

---
---

## Document 2: Finish The Missing Feature

**Header Info:**
* **System:** FilsPay (THE HANDOVER / CASE FILE)
* **Tag:** `ASSIGNED TO YOU`
* **Stamp:** `UNFINISHED` *(Red stamp top right)*
* **Ticket Metadata:**
  * Ticket: `FP-300`
  * Type: `Feature`
  * Priority: `High`
  * Status: `To do`
* **Requested By:** PRODUCT
* **Status Detail:** NEVER SHIPPED

---

### Description
The last developer started a feature but never finished it. Find out what it is, build it so it works from start to end, and host the app on Dilmune Cloud.

---

### DONE WHEN Checklist

- [ ] The feature **works from start to end**, through the API
- [ ] The **money is right** in the ledger, down to the fils
- [ ] **Fees and payouts** come out right
- [ ] The shop gets the **right webhook**
- [ ] It shows up right in the **timeline**, the **reports** and **reconciliation**
- [ ] The app is **live on Dilmune Cloud**, our hosting provider

---

### Margin Annotations & Notes
* **Coffee Ring Stain:** Present on the bottom-right of the checklist items.
* **Handwritten Note (bottom):**
  > *"looks easy. it isn't. it touches everything."*

---

*SPONSORED BY: BBK | American University of Bahrain | reboot 01 | HOPE Ventures*  
*HOSTED BY: DILMUNE*