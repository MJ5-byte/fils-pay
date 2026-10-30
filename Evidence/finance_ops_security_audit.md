# FilsPay Case File - Finance & Ops Weekly & Security Audit

---

## Document 1: Finance & Ops Weekly

**Header Info:**
* **System:** FilsPay (THE HANDOVER / CASE FILE)
* **Evidence Metadata:**
  * CASE NO.: `000`
  * ITEM: `02`
  * COLLECTED: `29.10.26`
* **Circulated:** `2026-09-20. Do not distribute.`
* **FROM:** Fatima H. (Finance)
* **RE:** Open items from the Sep 17 reconciliation review

---

### Overview
The numbers still don't match. I listed everything below, but nobody has time to check all of it before the audit. Leaving it for whoever picks this up.

---

### Reconciliation Items

- [ ] The scheme statement total is always a few fils higher than ours. It's always <ins>over, never under</ins> **((circled in red))** checked three months and it's the same every time. Something is rounding, but I can't find where.

- [ ] Related: the **March sweep script** was meant to fix the leftover gap for Q1. It did, but someone ran it twice on staging and the gap doubled. Nobody knows if it ran more than once on production. The log file only has one timestamp. Is it safe to run again? <ins>*I wouldn't.*</ins>

- [ ] **Split payouts** for Delta Marketplace: the three child payouts don't add up to the parent's total. It's small, a few tens of fils each batch, but it happens every batch since launch. Where do the missing fils go? I can't find them anywhere in the ledger.  
  * **Margin Annotation:** **`!!`** *(Red exclamation marks in left margin)*

- [ ] The **'Recalculate cached balances' button** in admin: I pressed it last Thursday and Alpha Retail's balance went from 135K to 7K. Yousif had to run the CLI rebuild to fix it. Why do the button and the CLI give different numbers?

- [ ] **MDR recalculation** changed batches that were already paid out. Those should never change. The settlement team says it only touches open batches, but I'm seeing changes on closed ones too.

- [ ] Support says the **fee shown in the merchant dashboard** isn't what we actually charge. It shows 245bps, but payments go through at 225bps. The two fee tables have different dates, and one was a backfill fix.

- [ ] The **CSV import** for manual changes: I uploaded 4.755 BD and the ledger shows 4.750. I uploaded 4.75 BD and it shows 0.475. That's ten times less. Something is wrong with how it reads BD amounts.  
  * **Margin Annotation:** **`10x??`** *(Red handwritten note in right margin next to coffee stain ring)*

---

### Group Chat Observations
> *Other things people said in the group chat. I haven't checked these:*
>
> - `"The daily close is running at 3am local, not midnight"`
> - `"Lifetime payout estimate drifts for high-volume merchants"`
> - `"Test merchants keep showing up in the real settlement run"`
> - `"Login works without entering the OTP code?"`
> - `"I cancelled merchant B's payment link from merchant A's dashboard"`

---

### Signature / Exit Note
I'm on leave next week. Good luck.

**`F.`** *(Red handwritten initial at the bottom right)*

---
---

## Document 2: Security & Code Audit

**Header Info:**
* **System:** FilsPay (THE HANDOVER / CASE FILE)
* **Stamp:** `CONFIDENTIAL` *(Red stamp top middle)*
* **Evidence Metadata:**
  * CASE NO.: `000`
  * ITEM: `01`
  * COLLECTED: `29.10.26`
* **Title:** SECURITY & CODE AUDIT
* **Subtitle:** ONBOARDING BRIEFING · CONFIDENTIAL

---

### Objective
> **Your job:** Check FilsPay, a payment app made for Bahrain. It signs up shops, takes card payments, and pays the shops their money. Everything is in Bahraini Dinar (BD). **1 BD = 1000 fils.**

---

### Tasks

| Step | Action | Description |
| :--- | :--- | :--- |
| **01** | **AUDIT** | Find security holes, money bugs and anything that breaks. |
| **02** | **FIX** | Fix each bug with the smallest change that works. |
| **03** | **EXPLAIN** | For each bug, write a short note: what's wrong, why, and what it breaks. |
| **04** | **BUILD** | Finish the missing feature and host it on Dilmune Cloud. See the back. |

---

### The Repo Structure

```text
apps/api/           TypeScript/Fastify API (auth, payments, webhooks, admin)
apps/settlement/    Go daemon (batch close, scheme export, splits, payouts)
apps/reporting/     TypeScript consumer (outbox events to rollups)
apps/web/           React hosted checkout
apps/admin/         React admin console
packages/money/     Shared integer-fils arithmetic
packages/events/    Outbox event types
db/migrations/      Postgres schema (numbered 0001 to 0072)
scripts/            One-off operational scripts
ops/                Docker compose, env files
docs/               Architecture, ADRs, runbook, handover notes
```

---

### Where to Start
* Start with `docs/ARCHITECTURE.md` and `docs/HANDOVER.md`
* Read every ADR in `docs/adr/`. They are the rules the code should follow
* **Money rule:** <ins>**whole fils only, never decimals**</ins> (ADR-0001) *(Highlighted/underlined)*
* **Settlement closes every day at midnight, Bahrain time (UTC+3)**
* Run `docker compose up` in `ops/` to start everything on your laptop

---

### Scoring Rules
> **SCORING:** Bigger bugs get more points, and so do clear explanations. Explaining why a bug happens scores more than just spotting it. A small fix that works scores more than a big rewrite.

---

*SPONSORED BY: BBK | American University of Bahrain | reboot 01 | HOPE Ventures*  
*HOSTED BY: DILMUNE*