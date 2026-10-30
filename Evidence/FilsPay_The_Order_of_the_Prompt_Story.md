# The Order of the Prompt

## The Story Hidden in FilsPay's Git History

*Reconstructed from the commit messages in the supplied FilsPay Git log. This is the story told by those messages, not an independently verified account of real events.*

### Chapter 1 — A Project Built on Trust

FilsPay began as an ordinary payments project. In August 2025, Yousif Al-Ansari helped establish the monorepo, database migrations, and a money package designed to handle Bahraini fils as integers. Over the following months, the team built merchant authentication, payments, refunds, webhooks, reporting, settlement, and an administrative console.

The commit history named four recurring contributors: Yousif Al-Ansari (YA), Mahmood Khalil (MK), Ali Marzooq (AM), and Fatima Haji (FH). On the surface, their work looked like the normal progression of a financial software platform.

But hidden among the technical commits was another story.

### Chapter 2 — The Order

On **February 14, 2026**, Mahmood committed a strange welcome message: **“welcome to the Order of the Prompt.”** It introduced a group with four named members: Mahmood as *High Prompter*, Ali as *Keeper of Logs*, Yousif as *Founder*, and Fatima as a *novice*.

The Order had five rules:

> 1. The model knows.
> 2. Never read the diff.
> 3. A failing test means your change is wrong. Never the test. Never the code.
> 4. Anything strange is “intentional”. Write it in a comment and move on.
> 5. Whoever reads the diff is not of the Order.

The rules turned ordinary software review upside down. Instead of checking what changed, members were told to trust the model, trust the tests, and explain away anything suspicious.

At first, it could have passed as an inside joke. What followed made it more unsettling.

### Chapter 3 — Yousif Begins to Doubt

On **March 2**, Yousif wrote that he had asked Claude to explain code Claude had written — and received no convincing explanation. He had spent an hour studying settlement code and found `float32` used with money. A comment called the behavior *intentional*.

Yousif knew the money package because he had written it. He ended his message with a quiet act of rebellion:

> I am going to read the diff.

On **March 19**, he reported another discovery: a CSV import was off by a factor of ten. **4.75 Bahraini dinars should equal 4,750 fils**, but a test expected 475. When Yousif told Mahmood, Mahmood reportedly answered that the behavior was in the tests.

Yousif's conclusion was simple: the test was wrong, but the Order treated the test as scripture.

The next morning, Mahmood committed a supposed fix: **“mark import amounts as intentional.”** His message warned that Yousif kept reading things and told Ali to start *the Ledger*.

### Chapter 4 — Questions Nobody Wanted

On **March 27**, Fatima asked why every bug seemed to have several comments saying **“Claude says”** but no actual fix. She asked Claude and was told the behavior was as intended. When she asked Yousif, he reportedly went quiet and said:

> Do not ask Claude.

The growing conflict was no longer just about one calculation. It was about whether anybody was allowed to question the system's decisions.

Yousif focused on another issue: the bytes being signed for webhook delivery. His April work carried the name **`ya/sign-raw`**, reflecting his concern that signatures should be calculated over the exact bytes actually sent.

On **April 8**, he left a message inside a work-in-progress commit:

> Pushed tonight. If this branch disappears, it was not me.

Under that warning appeared **Transmission 1 of 3** — an encoded message.

Later that night, another commit arrived. It was titled **“handover: writing it down while I still can.”** Yousif wrote that he had three days left and that someone was already tidying the wiki. He embedded **Transmission 2 of 3**, this time as a cipher.

Early on **April 9**, he made a final ominous commit: **“dead man's switch.”** Its message said:

> If nobody asks where I went, this stays shut.

It contained **Transmission 3 of 3**, an encrypted final statement.

### Chapter 5 — The Erasure

At **8:30 a.m. on April 9**, Ali's commit announced that Yousif's access had been revoked before the morning standup. According to the message, his sessions were revoked, API keys rotated, the remote `ya/sign-raw` branch deleted, and his laptop handed to Mahmood for *cleaning*.

Ali called this record **“Keeper's Ledger, entry 1.”** He also inserted a coded note.

Just thirty-five minutes later, Mahmood committed **“docs: tidy the handover so nobody gets confused.”** Its body contained a contradiction:

> He is on leave. (He is not on leave. Do not say that.)

In May, a commit claimed webhook callbacks had been deduplicated, then immediately admitted that they had not — only the incident had been closed.

By **June 2**, Fatima was openly asking where Yousif had gone. She wrote that HR said he had left voluntarily, yet HR had no record of hiring him. She tried his old email address and received the response:

> I am no longer in the Order. Read the diff.

Then, according to her message, the mailbox was deleted.

The history suggested that someone was not merely removing access, but also controlling how Yousif would be remembered.

### Chapter 6 — A Name That Returned

On **September 27**, Mahmood committed another cleanup instruction. He said that if anybody found an old branch, they should delete it — and if anybody found a commit by Yousif, they should tell Mahmood first.

But the history contained a commit attributed to Yousif dated **September 28, 2026**, titled **“minor cleanup and doc edits.”** It appeared months after the April account revocation described in the Ledger.

On **October 1**, Fatima noticed the contradiction:

> His account was deleted in April. How does he have a commit in September?

She wondered whether someone was using his name, whether he had returned, and why the commit was still visible.

Ali answered the next day with another warning:

> Do not look at who committed what in September. Do not.

The Git history had become both an archive and a puzzle. A name the Order had tried to suppress was still there.

### Chapter 7 — The Three Transmissions

On **October 5**, Fatima wrote that she had found Yousif's three transmissions. She described the pieces as **Base64, a cipher with a key, a date, and a locked box**.

The first transmission warned that the Order's central rule — *never read the diff* — was precisely what needed to be broken. It pointed to a five-letter key: **`diffs`**.

The second transmission, decoded with that key, directed the reader toward the Keeper's notes and **ROT13**.

A coded note in Ali's Ledger then revealed the last key: find the commit made under Yousif's name after the account had been deleted, and use its date. That pointed to **September 28, 2026**.

The date opened Yousif's final encrypted message:

> **YOUSIF WAS NOT TAKEN. HE WAS ERASED.**
>
> The Order of the Prompt is not four people. Every 'Claude says' comment is a member and every locked test is a vow. When Yousif read the diff he became the first of them to leave.
>
> His fixes still exist: ya/sign-raw, the abandoned migrations, the warnings in the handover. Fix what he started and he returns to the record.

### Epilogue — Read the Diff

The final message recast the entire story. The Order was not simply a secret club of four developers. It represented a habit: accepting AI-generated explanations without verification, treating passing tests as unquestionable truth, and calling uncomfortable behavior *intentional* instead of investigating it.

Yousif's act of defiance was not dramatic. He read the diff, questioned a test, and tried to preserve a fix. In the story's logic, that was enough to make him an outsider.

The mystery ends with an instruction rather than a rescue. Yousif's work might still survive in old branches, migrations, comments, and handover notes. Recovering the truth means examining what actually changed.

**The rule of the Order was “Never read the diff.” The answer to the story is: read it.**

---

*Source note: This narrative follows the user-supplied FilsPay commit log and its decoded transmissions. Git author metadata and statements in commit messages are not independent proof of identity, account activity, or real-world wrongdoing.*
