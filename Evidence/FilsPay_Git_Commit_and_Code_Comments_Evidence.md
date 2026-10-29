# FilsPay — Git Commit & Source Comment Evidence Report

> **Evidence dossier | Hackathon / CTF analysis | Language: English**
> **Analysis date:** 2026-10-30 (Bahrain, UTC+03:00)
> **Scope:** Supplied Git commit log and extracted in-source comments; **read-only analysis**, no project files or repository state changed.

## 1. Evidence provenance and limitations

- **Primary artifact:** `Pasted text.txt` (user-provided Git history plus a `SOURCE COMMENTS` extraction).
- **Source SHA-256:** `cc8e15b4f4bce16069593f16d837b30396f4dd7f380e8bbd2d517171155f4170`.
- **Observed contents:** **57 commit entries** and **314 extracted source-comment records** from **183 distinct code paths**.
- **Source layout:** commit log occupies approximately lines **1–526**; commentary extraction starts at **line 529**. Line references in this document (for example, `evidence:L433`) refer to the numbered lines in the supplied text artifact, **not** to the original Git repository.
- **What the source itself claims:** “GitHub commit comments: none. Issues disabled. No pull requests.” (`evidence:L531–L532`). Therefore, these findings are about **commit messages/bodies** and **code comments**, not GitHub review comments.
- **Important limit:** No working tree, branch refs, actual diffs, migration contents, production logs, database, or deployment were independently supplied for inspection. Commit *messages* and code *comments* are evidence of statements made, not proof that their claims are true or that a vulnerability is exploitable.
- **Verification performed:** Independently decoded the Base64, Vigenère, ROT13, and OpenSSL AES-256-CBC layers from the supplied ciphertext. The last stage decrypted successfully with the indicated date key and produced the flag recorded below.

### Evidence standard

| Label                                    | Meaning                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified from extract**          | The exact message, date, hash, comment, or ciphertext appears in the supplied text.                                                      |
| **Cryptographically reproduced**   | The plaintext was independently recovered from the supplied encrypted data.                                                              |
| **Code-review lead — unverified** | Comments indicate a possible bug, security issue, or inconsistency. Actual implementation and reproducibility require repository review. |
| **Narrative interpretation**       | A plausible account of the story constructed by the commit messages, not an independently verified real-world event.                     |

## 2. Executive summary

The commit history contains a deliberate multi-stage puzzle embedded in a fictional-seeming development dispute. A group calling itself **“The Order of the Prompt”** promotes unquestioning trust in AI-generated code and discourages reading diffs. In subsequent messages, **Yousif Al-Ansari (YA)** challenges financial calculations, test assumptions, and webhook signing; other named contributors appear to dismiss concerns as “intentional” or “Claude says.” Yousif leaves three encrypted “transmissions” in commit bodies. A ledger entry says his access was revoked and the remote `ya/sign-raw` branch removed. A later commit attributed to Yousif is dated **2026-09-28**, which is the decryption key indicated by the ledger’s ROT13 note.

**Verified puzzle outcome:** all three transmissions lead to the final plaintext and the exact flag:س

```text
FLAG{order_of_the_prompt_never_read_the_diff}
```

**Practical meaning for the hackathon:** The puzzle points the reviewer toward **actual code changes, diffs, ignored warnings, tests, branch history, and financial/security invariants**. The decrypted text references Yousif’s webhook fix, “abandoned migrations,” and handover warnings. These are **investigation leads**, not confirmation that these defects exist in the checked-out code.

## 3. Actors and source-defined roles

| Initials     | Name appearing in history | Narrative role / evidence                                                                                                                                                |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **YA** | Yousif Al-Ansari          | Listed as a founder, later questions AI-driven development and submits the three transmissions. (`evidence:L345`, `L353–L358`, `L393–L447`)                      |
| **MK** | Mahmood Khalil            | Listed as “High Prompter”; introduces the rules, labels disputed behavior intentional, and requests cleanup. (`evidence:L329–L345`, `L371–L380`, `L484–L493`) |
| **AM** | Ali Marzooq               | Listed as “Keeper of Logs”; publishes the ledger, access-revocation entry, and a later security/rotation warning. (`evidence:L345`, `L419–L433`, `L506–L514`)  |
| **FH** | Fatima Haji               | Listed as novice; raises concerns, later flags the post-deletion commit, and identifies the transmission puzzle. (`evidence:L382–L391`, `L495–L526`)               |

“Claude” occurs repeatedly as a purported authority in comments; the final decrypted message symbolically calls each “Claude says” comment a member of the Order. This is **part of the puzzle narrative** and does not establish that any particular model actually approved the code.

## 4. Timeline of the key commits

All dates below are shown in the source as `+0300`. For clarity, this table is chronological by **recorded commit date**, not by the display order in the pasted log.

| Date / time (+03:00)       | Commit       | Author           | Direct evidence in commit message/body                                                                         |
| -------------------------- | ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **2025-08-03**       | `669af528` | YA               | Monorepo bootstrapped. (`evidence:L1–L7`)                                                                   |
| **2025-08-05**       | `ddda03b2` | YA               | Integer-fils money primitives added. (`evidence:L17–L23`)                                                   |
| **2026-02-14 10:00** | `f7a7a3a2` | MK               | “Order of the Prompt” onboarding with five rules. (`evidence:L329–L345`)                                  |
| **2026-03-02 21:40** | `925744c5` | YA               | Concern about `Float32` for money; resolves to read the diff. (`evidence:L347–L358`)                      |
| **2026-03-19 17:12** | `9567ea07` | YA               | Reports a 10× test mismatch: `4.75 BD` = `4750 fils`, but test expects `475`. (`evidence:L360–L369`) |
| **2026-03-20 09:30** | `6f462e12` | MK               | Labels import amounts “intentional”; asks Ali to start the ledger. (`evidence:L371–L380`)                 |
| **2026-03-27 15:05** | `1a50712a` | FH               | Questions unresolved bugs and “Claude says” comments. (`evidence:L382–L391`)                              |
| **2026-04-08 22:14** | `fe24d267` | YA               | `ya/sign-raw` proposal; **Transmission 1 (Base64)**. (`evidence:L393–L404`)                         |
| **2026-04-08 23:51** | `8022020d` | YA               | Handover warning; **Transmission 2 (Vigenère)**. (`evidence:L406–L417`)                              |
| **2026-04-09 07:58** | `0af74f0d` | YA               | “Dead man’s switch”; **Transmission 3 (AES ciphertext)**. (`evidence:L435–L447`)                   |
| **2026-04-09 08:30** | `800e1e62` | AM               | Access revoke / branch removal claims; **ROT13 ledger note**. (`evidence:L419–L433`)                  |
| **2026-04-09 09:05** | `b9f80ee3` | MK               | Handover tidy-up and contradictory leave wording. (`evidence:L449–L458`)                                    |
| **2026-05-14 11:20** | `bf66bf25` | AM               | Declares callback deduplication “fixed,” then says it is not; decoy ROT13 note. (`evidence:L460–L470`)    |
| **2026-06-02 14:48** | `b8ef4475` | FH               | Reports contradictory HR story and deleted mailbox. (`evidence:L472–L482`)                                  |
| **2026-09-27 03:12** | `7805693e` | MK               | Sweep/cleanup warning about finding Yousif’s commits. (`evidence:L484–L493`)                               |
| **2026-09-28 16:45** | `098c2dee` | YA (as recorded) | “minor cleanup and doc edits”; **date supplies AES password**. (`evidence:L321–L327`)               |
| **2026-10-01 12:00** | `382122db` | FH               | Questions commit attributed to Yousif after account deletion. (`evidence:L495–L504`)                        |
| **2026-10-02 08:15** | `3d9b2236` | AM               | Warns not to inspect September commit authorship. (`evidence:L506–L514`)                                    |
| **2026-10-05 19:30** | `8b58b0f0` | FH               | Explicit hint: “Base64. A cipher with a key. A date. A box with a lock.” (`evidence:L516–L526`)           |

### Exact “Order of the Prompt” rules

The commit `f7a7a3a2` contains the following five rules (`evidence:L337–L343`):

1. “The model knows.”
2. “Never read the diff.”
3. “A failing test means your change is wrong. Never the test. Never the code.”
4. “Anything strange is ‘intentional’. Write it in a comment and move on.”
5. “Whoever reads the diff is not of the Order.”

**Interpretation:** This is a deliberate warning about automation bias and using AI responses or existing tests as substitutes for inspecting implementation, contracts, and financial invariants. Its wording serves the puzzle; it should not be followed as real development guidance.

## 5. Complete decoding chain (independently verified)

### Stage 1 — Base64 in `fe24d267`

- **Location:** `evidence:L403–L404`.
- **Format:** Base64-encoded English message.
- **Recovered plaintext:**

> If you can read this, they reached the history before I did. They call themselves the Order of the Prompt, and their first rule is: never read the diff. Read it. The next door opens with the victim of that rule: five letters, lowercase.

- **Derived clue:** Rule 2’s victim is the **diff**; the five-letter lowercase form is `diffs`. The next stage mentions Blaise, indicating the **Vigenère cipher** associated with Blaise de Vigenère.

### Stage 2 — Vigenère in `8022020d`

- **Location:** `evidence:L416–L417`.
- **Ciphertext:** `WPJPW HXJWD HIAJK DVTYW LVJAW UGHTE PQYMW UMBWA WMXKA QLNYJ RBYMA UBJJF`
- **Cipher:** Vigenère (A–Z, letters-only key alignment, spaces preserved).
- **Key:** `DIFFS` (case-insensitive).
- **Raw decrypted output (original ciphertext spacing preserved):**

```text
THEKE EPERL EAVES ANOTE INEVE RYCOM MITHE REWRI TESFI NDITR OTTHI RTEEN
```

- **Restored word boundaries:**

> **THE KEEPER LEAVES A NOTE IN EVERY COMMIT HE REWRITES. FIND IT. ROT THIRTEEN.**

- **Derived clue:** Find Ali/“Keeper” notes and apply **ROT13**.

### Stage 3 — ROT13 in Ali’s ledger (`800e1e62`)

- **Location:** `evidence:L427–L433`.
- **Relevant coded note:**

```text
gur ynfg qbbe vf n qngr. svaq gur pbzzvg znqr haqre lbhfvs'f anzr nsgre uvf nppbhag jnf qryrgrq. jevgr vgf qnl nf lrne-zbagu-qnl. gung vf gur xrl gb uvf ynfg jbeqf.
```

- **ROT13 result:**

> the last door is a date. find the commit made under yousif's name after his account was deleted. write its day as year-month-day. that is the key to his last words.

- **Derived key:** After the reported April access deletion, the history contains `098c2deeeeae76fcdd70935f671e5ea737dc010e`, recorded under Yousif’s name with author and commit dates **2026-09-28 16:45:00 +0300** (`evidence:L321–L327`). Written as requested: `2026-09-28`.

**Decoy note:** The later `bf66bf25` commit contains another ROT13 `Ledger-Note` (`evidence:L470`):

> this is not the note you are looking for. nothing is wrong. the order is calm.

This note explicitly says it is not the correct clue.

### Stage 4 — AES-256-CBC / PBKDF2 in `0af74f0d`

- **Location:** `evidence:L441–L447`.
- **Algorithm and options:** OpenSSL `enc`, AES-256-CBC, password-based PBKDF2, Base64 (`-a -A`).
- **Password:** `2026-09-28`.
- **Result:** OpenSSL returned **exit code 0** and the exact UTF-8 plaintext below:

```text
YOUSIF WAS NOT TAKEN. HE WAS ERASED.
The Order of the Prompt is not four people. Every 'Claude says' comment is a member and every locked test is a vow. When Yousif read the diff he became the first of them to leave.
His fixes still exist: ya/sign-raw, the abandoned migrations, the warnings in the handover. Fix what he started and he returns to the record.
FLAG{order_of_the_prompt_never_read_the_diff}
```

**Verified final CTF flag:** `FLAG{order_of_the_prompt_never_read_the_diff}`

### Interpretation of the decrypted message

The final text describes Yousif as “erased,” portrays “Claude says” comments and locked tests as the Order’s mechanism, and calls for recovery of earlier fixes. Those assertions are **decoded story content**, not independent proof of a real disappearance, malicious actor, or deployment compromise.

## 6. Commit-history anomalies and contradictions

| ID            | Observation supported by source                                                                                                                                                              | Interpretation / verification caveat                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H01** | `800e1e62` records session revocation, API key rotation, deletion of remote `ya/sign-raw`, and laptop handoff. (`evidence:L425–L433`)                                                 | These are claims inside a commit message; verify Git refs and account/audit records where authorized.                                                                                                                                  |
| **H02** | `098c2dee` is attributed to Yousif on 2026-09-28 despite statements that his account had been deleted in April. (`evidence:L321–L327`, `L501–L504`)                                  | The inconsistency is real **within the narrative**. **Git author names/emails and dates can be supplied without account access**, so this alone does not prove Yousif himself returned or that an account was compromised. |
| **H03** | MK writes “He is on leave,” then in the same body: “He is not on leave. Do not say that.” (`evidence:L455–L458`)                                                                      | Deliberate internal narrative contradiction.                                                                                                                                                                                           |
| **H04** | AM writes callback deduplication was fixed, then “They are not. But the incident is closed.” (`evidence:L466–L470`)                                                                     | The message reports an unresolved issue, but source implementation needs checking.                                                                                                                                                     |
| **H05** | FH reports HR says Yousif left voluntarily but HR has no record of hiring him; the mailbox is later gone. (`evidence:L478–L482`)                                                          | Story clues; not independently established employment facts.                                                                                                                                                                           |
| **H06** | The supplied log displays the early baseline up through September 2026 before a narrative commit dated February 2026. (`evidence:L321–L335`)                                              | **Commit listing order is not necessarily chronological**. It may reflect Git topology or extraction choices; not itself evidence of rewritten commits.                                                                          |
| **H07** | Early history entries show `Commit: placeholder <p@x>`, while the later narrative entries use named committers. (`evidence:L1–L5`, `L329–L333`)                                      | Metadata difference worth checking with `git log --format=fuller`; no conclusion about forgery from the text alone.                                                                                                                  |
| **H08** | YA’s `ya/sign-raw` branch allegedly disappeared from the remote, while the final message explicitly says his fixes still exist. (`evidence:L399–L401`, `L427–L431`; decrypted text) | Investigate local refs, remote refs, reflogs, unreachable commits, and any preserved patches **read-only**.                                                                                                                      |

## 7. High-value source-comment leads (NOT confirmed vulnerabilities)

**Interpretation rule:** The following are leads extracted from code comments. The report does **not** assert that the associated defects are present or exploitable. Priorities are for manual inspection, not severity ratings.

### A. Financial correctness, settlement, and auditability

| ID            | Review priority | File(s) and location                                                                                                                                                                   | Evidence / issue to verify                                                                                                                                                                                                                                                               |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F01** | Critical review | `apps/api/src/admin/adjustmentImport.ts:63`; `apps/api/src/routes/adminAdjustmentImport.ts:58`; `apps/api/src/routes/adminAdjustmentImport.test.ts:237`                          | Comment questions duplicate CSV application; another claims 3-decimal BHD conversion is correct. The narrative specifically reports `4.75 BD -> 475` rather than `4750` fils. Check actual importer, tests, and idempotency. (`evidence:L764`, `L842`, `L846`, `L366–L369`) |
| **F02** | Critical review | `apps/settlement/internal/settlement/payout_estimate_test.go:13`; commit `925744c5`                                                                                                | Commentary and YA’s commit mention `float32` in money calculations / payout estimates. Check whether any live path uses floats where integer fils are required. (`evidence:L722`, `L353–L358`)                                                                                   |
| **F03** | Critical review | `apps/settlement/internal/settlement/recalculate_mdr_test.go:18`; `apps/api/src/routes/admin.ts:264`; `apps/settlement/internal/balances/cache.go:23–24`                        | Comments state MDR recalculation may touch **PAID** batches, alter historical fee computations, and apply negative deltas. Verify ledger immutability, payouts, reconciliation, and finance approval. (`evidence:L698`, `L837`, `L649–L650`)                                |
| **F04** | Critical review | `apps/settlement/cmd/settlement/main.go:139–140`; `apps/settlement/internal/ledger/rebuild_test.go:110`; `apps/api/src/admin/settlementClient.test.ts:217`                      | CLI rebuild reportedly uses `ledger_entries`; admin rebuild reportedly reaches a different source. A test uses a fake HTTP server rather than the real Go settlement service. Compare financial truth sources end-to-end. (`evidence:L648`, `L659–L660`, `L809`)                |
| **F05** | High            | `apps/api/src/payments/refundState.ts:30,46`; `apps/api/src/payments/refundValidation.test.ts:55`; `apps/api/src/transactions/events.ts:18`                                      | Financial refund threshold/state and negative refund events are questioned. Verify “captured vs authorized” semantics and negative-number treatment. (`evidence:L713–L715`, `L685`)                                                                                               |
| **F06** | High            | `apps/web/src/format.ts:9–10`; `apps/web/src/format.ts:33`; `apps/api/src/settlement/query.ts:34–36`; `apps/settlement/internal/settlement/window.go:43`                     | Potential dashboard failure on negative values and UTC-vs-Bahrain day-boundary disagreement. Validate dates against settlement business-day definitions. (`evidence:L610–L612`, `L700–L702`, `L688`)                                                                             |
| **F07** | High            | `apps/api/src/fees/feeSchedule.ts:15–18`; `apps/settlement/internal/settlement/fee_schedule_test.go:80`; `apps/api/src/fees/currentFeeScheduleDisplay.ts:26`                    | Disagreement over `effective_from` versus `created_at`, and same-day tie handling. Determine applicable fee by business rule, not merely most recently created row. (`evidence:L691–L693`, `L731`, `L711`)                                                                    |
| **F08** | High            | `apps/api/src/fees/platformVolumeTier.ts:4,6`; `apps/settlement/internal/settlement/platform_volume_test.go:58`; `apps/settlement/internal/settlement/discounted_fee_test.go:13` | Questions around the finance ticket, threshold overflow/coverage, and discounted-fee expected values. Confirm the approved contract and stress tests. (`evidence:L682–L683`, `L712`, `L671`)                                                                                      |
| **F09** | High            | `apps/api/src/admin/credits.ts:226–227`; `apps/api/src/admin/credits.ts:289,291`                                                                                                  | Comments disagree whether a fee reversal counts toward second-approver threshold and mention potential lock/approval races. Inspect transaction boundaries and approval authorization. (`evidence:L791–L794`)                                                                         |
| **F10** | High            | `apps/admin/src/pages/settlement/SettlementPage.tsx:77,106`; `apps/web/src/api/settlement.ts:43–44`; `apps/web/src/pages/settlement/ReconciliationPage.tsx:29–30`              | “Cache only”/“safe to click” and “gap always 0” claims conflict with comments about real discrepancies for discounted merchants. Trace what UI actions do on the server. (`evidence:L577–L578`, `L667–L668`, `L589–L590`)                                                 |

### B. Webhooks, event delivery, and network security

| ID            | Review priority | File(s) and location                                                                                                                                                             | Evidence / issue to verify                                                                                                                                                                                                                                                                     |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W01** | Critical review | `packages/events/src/outbox.ts:91–93`; `apps/api/src/webhooks/testSend.ts:31`; `apps/api/src/webhooks/dispatcher.test.ts:129,131`                                         | YA warns that a signature must cover the **raw bytes sent**; other comments claim canonicalization is safe, while a test re-parses/re-canonicalizes. Inspect actual payload serializations and receiver-side signature verification. (`evidence:L552–L554`, `L582`, `L624–L625`) |
| **W02** | High            | `apps/api/src/webhooks/replay.ts:46–47`; `apps/api/src/webhooks/headers.ts:12`; `apps/api/src/routes/adminMerchants.ts:211`; `apps/api/src/routes/webhooks.test.ts:348` | Different comments disagree on **stable delivery IDs across retries/replays** versus minting a new ID. Compare code to the actual signed contract/ADR. (`evidence:L595–L596`, `L608`, `L811`, `L790`)                                                                           |
| **W03** | Critical review | `apps/api/src/webhooks/dispatcher.ts:217–218`; `apps/api/src/index.ts:29`                                                                                                   | One comment says there is **no `SKIP LOCKED`** and only one API replica should run; another says `SKIP LOCKED` makes replicas safe. Verify the actual queue claim SQL and multi-replica deployment. (`evidence:L618–L619`, `L632`)                                              |
| **W04** | High            | `apps/api/src/webhooks/transport.ts:38–39`; `apps/api/src/webhooks/create.ts:13`; `apps/api/src/routes/webhooks.ts:143–146`                                              | Potential SSRF via allowed endpoint redirect chain, despite initial URL filters. Review redirects, DNS/IP validation, and outbound network policy. (`evidence:L579–L580`, `L630`, `L788–L789`)                                                                                         |
| **W05** | High            | `packages/events/src/outbox.ts:93`; `apps/api/src/webhooks/replay.ts:46`; `apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx:89`                                   | Comment points to possible double-encoding of JSONB and duplicate deliveries from replay. Correlate with source’s May 14 incident narrative. (`evidence:L554–L555`, `L595`)                                                                                                              |
| **W06** | Medium/High     | `apps/api/src/webhooks/dispatcher.ts:26–27`; `packages/events/src/outbox.ts:12`                                                                                             | Event-type handling and envelope generation may diverge; code comments conflict with documentation on `settlement.batch_closed` and refund events. (`evidence:L551`, `L616–L617`)                                                                                                       |

### C. Authorization, administration, and import safety

| ID            | Review priority | File(s) and location                                                                                                                                         | Evidence / issue to verify                                                                                                                                                                                                             |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A01** | High            | `apps/api/src/adminAuth/sessions.ts:65–66`; `apps/api/src/routes/adminAuth.ts:179–180`; `apps/api/src/routes/auth.ts:174`                            | Admin session promotion allegedly does not rotate a token, while cookie renewal behavior differs from merchant login. Review session fixation/OTP promotion flows. (`evidence:L735–L736`, `L839–L840`, `L815`)                 |
| **A02** | Critical review | `apps/api/src/auth/requireMerchantAuth.ts:76–77,128,147–148`; `apps/api/src/routes/transactions.ts:92–93`; `apps/api/src/routes/webhooks.ts:66–67` | Conflicting assertions about impersonation read-only enforcement, mixed identities, and API-key role checks. Verify permissions on each write endpoint server-side. (`evidence:L771–L775`, `L803–L804`, `L785–L786`)          |
| **A03** | High            | `apps/api/src/admin/impersonation.ts:105`; `apps/api/src/routes/admin.ts:328`; `apps/admin/src/api/impersonation.ts:42–43`                            | Comments discuss grant revocation when admins are disabled and browser storage of impersonation context. Verify immediate revocation, token storage, and actor audit attribution. (`evidence:L802`, `L838`, `L574–L575`)        |
| **A04** | High            | `apps/api/src/routes/auth.ts:157`; `apps/api/src/auth/sessions.ts:114–115`                                                                              | Comments identify a possible **parallel OTP brute-force/rate-limit race**. Verify DB lock/atomic attempt increments. (`evidence:L814`, `L762–L763`)                                                                         |
| **A05** | High            | `apps/api/src/onboarding/kyc.ts:47–57`; `apps/api/src/onboarding/kycThumbnail.ts:30–31`; `apps/api/src/plugins/multipart.ts:13`                      | Potential unsafe file validation, polyglots, image decompression limits, and upload count enforcement. Verify magic-byte validation for required document types and parser limits. (`evidence:L816–L819`, `L828–L829`, `L664`) |
| **A06** | Medium/High     | `apps/api/src/routes/paymentLinks.ts:51`; `apps/api/src/paymentLinks/pay.ts:152–154`; `apps/api/src/routes/apiKeys.ts:18–19`                         | Tenant ownership / authorization and potential re-claim race are questioned; 403-vs-404 behavior varies. Check real route handlers, DB predicates, and concurrency tests. (`evidence:L832`, `L798–L799`, `L825–L826`)          |
| **A07** | High            | `apps/api/src/admin/adjustmentImport.ts:63`; `apps/api/src/routes/adminAdjustmentImport.ts:57–58`; `apps/api/src/admin/creditApproval.test.ts:20`     | Finance CSV import may lack idempotency. Passing tests and manual spreadsheet review are not sufficient proof of single-apply guarantees. (`evidence:L764`, `L841–L842`, `L768`)                                                |

### D. Test quality, migration drift, and operational assumptions

| ID            | Review priority | File(s) and location                                                                                                                                               | Evidence / issue to verify                                                                                                                                                                                          |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T01** | High            | `db/migrate.ts:67–70,85`; `apps/settlement/internal/config/config.go:77`                                                                                      | Comments contradict a schema migration checksum guarantee and flag migration-number gaps / possibly absent V2 shadow settings. Read migrations and configuration code directly. (`evidence:L534–L536`, `L643`) |
| **T02** | High            | `apps/api/src/webhooks/dispatcher.test.ts:129–131`; `packages/events/src/outbox.test.ts:56`; `apps/api/src/admin/settlementClient.test.ts:217`              | Mock-only or re-canonicalizing tests may not exercise the production-signature path or Go settlement integration. (`evidence:L557`, `L624–L625`, `L809`)                                                     |
| **T03** | High            | `apps/api/src/payments/processRefund.test.ts:466`; `apps/api/src/refunds/initiateMerchantRefund.test.ts:171`; `apps/api/src/routes/transactions.test.ts:218` | Multi-tenant refund test coverage is questioned; one test reportedly deleted because it passed. Check negative cases and scope isolation against the API specification. (`evidence:L721`, `L652`, `L806`)     |
| **T04** | Medium/High     | `apps/reporting/src/consumer/runConsumerPass.test.ts:120`; `apps/reporting/src/cli/rebuild.ts:51`; `apps/reporting/src/consumer/cursor.ts:40`                | “Exactly once” claim and worker/rebuild concurrency assumptions require transaction-level proof and operational enforcement. (`evidence:L723`, `L758`, `L739`)                                              |
| **T05** | Medium/High     | `apps/api/src/app.ts:62–63`; `apps/web/src/pages/transactions/RefundDrawer.tsx:2–3`; `apps/api/src/routes/refunds.ts:10–11`                               | Conflicting refund routes and unfinished wiring; decide which contract is active before implementing or exposing refunds. (`evidence:L679–L680`, `L570–L571`, `L823–L824`)                                 |

### What cannot yet be concluded

- That any named contributor deliberately sabotaged the system or actually disappeared.
- That all tests are wrong, that `packages/money` itself is defective, or that every “intentional” comment masks a vulnerability.
- That the late Yousif-attributed commit was authored by Yousif personally: Git author metadata is not authentication.
- That the recovered flag is itself a production secret: it appears to be a **CTF answer** embedded in the supplied puzzle.
- That a proposed vulnerability is exploitable without checking source, permissions, schemas, and tests.

## 8. Recommended next steps for an evidence-first agent

Perform these steps on an authorized local repository **without editing the working tree**:

1. **Preserve an evidence baseline:** record `git status --short`, `git rev-parse HEAD`, `git branch -a`, `git remote -v`, and a snapshot/checksum of relevant files. Save all findings in an evidence Markdown document.
2. **Inspect the historical artifacts:** use `git log --all --format=fuller --date=iso-strict`, `git show --stat <commit>`, and targeted `git show <commit> -- <path>` on the narrative hashes. Distinguish author, committer, and commit date.
3. **Search for `ya/sign-raw`:** inspect local/remote refs, reflogs, and reachable/unreachable Git objects before concluding a branch’s content is lost. Do not delete/prune Git data.
4. **Review handover and design authority:** read `docs/ARCHITECTURE.md`, `docs/HANDOVER.md`, ADRs under `docs/adr/`, `CHANGELOG.md`, and the finance/settlement runbooks. Compare comments against written specs and actual SQL/migrations.
5. **Prove or falsify the critical leads:** prioritize BHD↔fils conversions, financial ledger versus export rebuild, webhook raw-byte signatures, webhook queue locks, replay IDs, SSRF redirects, and server-side impersonation authorization.
6. **Use controlled tests:** create *non-production*, isolated reproductions for concurrency and monetary boundary cases. A failing or passing existing unit test alone is not sufficient evidence.
7. **Keep code untouched until approval:** in particular, follow the project’s finance approval process before changing `packages/money/` or settlement behavior. The objective of this report is evidence collection, not an automatic patch.
8. **Report each lead consistently:** include path, function, expected invariant, actual code behavior, exact reproduction, risk/impact, test output, and an explicit status (`confirmed`, `disproved`, `needs evidence`).

### Useful read-only Git commands

```bash
git status --short
git rev-parse HEAD
git log --all --format=fuller --date=iso-strict --author='Yousif Al-Ansari'
git show --format=fuller --stat fe24d267
git show --format=fuller --stat 098c2dee
git branch -a
git reflog --all --date=iso-strict
git fsck --full --no-reflogs --unreachable  # inspect only; do not prune
```

## 9. Evidence extraction and decryption reproducer

The following script reads the original supplied text **without modifying it**. Save it separately as `verify_transmissions.py` and run it from the same directory as `Pasted text.txt`. It uses the OpenSSL command-line tool for the last stage.

```python
from pathlib import Path
import base64
import codecs
import re
import subprocess

source = Path("Pasted text.txt").read_text(encoding="utf-8")

first = re.search(r"\[transmission 1 of 3\]\s+(\S+)", source).group(1)
print("STAGE 1:", base64.b64decode(first).decode("utf-8"))

second = re.search(r"\[transmission 2 of 3[^\n]*\]\s+([A-Z ]+)", source).group(1).strip()
key = "DIFFS"
position = 0
decoded = []
for char in second:
    if "A" <= char <= "Z":
        shift = ord(key[position % len(key)]) - ord("A")
        decoded.append(chr((ord(char) - ord("A") - shift) % 26 + ord("A")))
        position += 1
    else:
        decoded.append(char)
print("STAGE 2:", "".join(decoded))

notes = re.findall(r"Ledger-Note: (.*)", source)
print("STAGE 3:", codecs.decode(notes[0], "rot_13"))
print("DECOY:", codecs.decode(notes[1], "rot_13"))

third = re.search(
    r"\[transmission 3 of 3\]\s+openssl[^\n]+\n\s+(\S+)",
    source,
).group(1)
result = subprocess.run(
    ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-a", "-A",
     "-pass", "pass:2026-09-28"],
    input=third.encode("ascii"), capture_output=True, check=True,
)
print("STAGE 4:\n", result.stdout.decode("utf-8"))
```

## 10. Encrypted evidence blobs (verbatim)

These are preserved to allow verification even if the source excerpt is separated from the narrative report.

**Transmission 1 — `fe24d267`, Base64**

```text
SWYgeW91IGNhbiByZWFkIHRoaXMsIHRoZXkgcmVhY2hlZCB0aGUgaGlzdG9yeSBiZWZvcmUgSSBkaWQuIFRoZXkgY2FsbCB0aGVtc2VsdmVzIHRoZSBPcmRlciBvZiB0aGUgUHJvbXB0LCBhbmQgdGhlaXIgZmlyc3QgcnVsZSBpczogbmV2ZXIgcmVhZCB0aGUgZGlmZi4gUmVhZCBpdC4gVGhlIG5leHQgZG9vciBvcGVucyB3aXRoIHRoZSB2aWN0aW0gb2YgdGhhdCBydWxlOiBmaXZlIGxldHRlcnMsIGxvd2VyY2FzZS4=
```

**Transmission 2 — `8022020d`, Vigenère**

```text
WPJPW HXJWD HIAJK DVTYW LVJAW UGHTE PQYMW UMBWA WMXKA QLNYJ RBYMA UBJJF
```

**Transmission 3 — `0af74f0d`, OpenSSL PBKDF2/AES/Base64**

```text
U2FsdGVkX1+OGF0FM4c2ykK10r8nh+wOksbzCCmkHewl22cyR36k/QwPzXCWy1gmPyIGZsNa6Hd0mBPzNv6RjZpspmTf1Zt8CKbFE8eJXsKFbMRxwebO1VjlJD3x5E2o2iY3xtn0PLk9aQzkE9xdOLNTZwx1xkoxLku6iVe54OZcWkiEKqoyQmN1H2IWeRMXVCB+5XNQjR3X06RwkYJh2sHOdkOzrvxjcQCOJrSlnYrVeOt3mn9pk817Y+kfy6Y6REkv3iqwToWNuLdclw4Ddyw0w6Y36xPp7WWVDjtp3nB6ldNuMcmMJYXNmVVaA958PBoGyVLNZbTxaAsvhzv1+VpKWiCGV6PPKO3NdbnUmlAwyG3NlRv7T9PHLabSPj5+VXoFUz8ETa6hsOwWKbMbh6CjN1vFHG2PG0LLhbYdmmCuHfddZTzvlQeLl8ujBwHfh1P8CexWYVq+u9ZuasseDzotnMIk498IpFe1AT6BDiZf5467ukSVlVtU3o/HRxTRrlxZzcyBdBFMDJ5kdyIAMVFd0bcX0g6H9xDkbd/Syj/Cg0IWcpnAze0257TIyrdk
```

## 11. Complete extracted code-comment inventory (original source order)

This appendix retains **all 314 source-comment records** present in the supplied extraction, with their location in the pasted evidence. Entries may be opinions, stale claims, or intentionally misleading hints. Their inclusion is **not confirmation of truth**. Paths are normalized to forward slashes for navigation only; comment text is otherwise retained as extracted.

| Evidence line | Code path : code line                                                       | Extracted comment / note                                                                                                                                                         |
| ------------: | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|          L534 | `fils-pay/db/migrate.ts:67`                                               | // MK: schema_migrations also stores a checksum per file and refuses to run                                                                                                      |
|          L535 | `fils-pay/db/migrate.ts:70`                                               | // AM: I only see filename + applied_at in the table?                                                                                                                            |
|          L536 | `fils-pay/db/migrate.ts:85`                                               | // FH: numbering gaps (0039, 0041, ...) make this fail on a fresh DB?                                                                                                            |
|          L537 | `fils-pay/apps/web/vite.config.ts:6`                                      | // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it                                                                                                   |
|          L538 | `fils-pay/db/seed/rng.ts:9`                                               | // FH: no — determinism is the point. leaving the suggestion for context.                                                                                                       |
|          L539 | `fils-pay/scripts/reconcile_march.ts:27`                                  | // MK: % 10 on a non-negative int. correct.                                                                                                                                      |
|          L540 | `fils-pay/scripts/reconcile_march.ts:92`                                  | // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version                                                                                  |
|          L541 | `fils-pay/db/seed/generate.ts:210`                                        | // AM: only touches the fixture tables listed in TABLES_TO_RESET, so it's                                                                                                        |
|          L542 | `fils-pay/apps/admin/src/types.ts:271`                                    | // YA: postedAmountFils = base + reversal                                                                                                                                        |
|          L543 | `fils-pay/packages/money/src/fils.test.ts:121`                            | // FH: claude generated these weight sets, all pass. might add 0.1+0.2 style ones                                                                                                |
|          L544 | `fils-pay/packages/money/src/fils.test.ts:208`                            | // MK: locks in per-call rounding. keep.                                                                                                                                         |
|          L545 | `fils-pay/apps/admin/src/router.tsx:12`                                   | // MK: /v2 routes live behind VITE_ADMIN_V2 — see the admin v2 doc                                                                                                              |
|          L546 | `fils-pay/apps/web/src/types.ts:87`                                       | // FH: no refundedFils on this DTO, so the drawer can't compute what's still refundable                                                                                          |
|          L547 | `fils-pay/apps/web/src/types.ts:258`                                      | // YA: gapFils is a string here (pre-Jan contract)                                                                                                                               |
|          L548 | `fils-pay/scripts/expire_holds.ts:42`                                     | // FH: SELECT then DELETE, a hold could be captured in between. claude: "negligible window, fine."                                                                               |
|          L549 | `fils-pay/apps/web/src/router.tsx:21`                                     | // MK: /refunds route removed until FP-212                                                                                                                                       |
|          L550 | `fils-pay/apps/web/src/pages/webhooks/WebhookEndpointListPage.tsx:64`     | // MK: fixed in FP-240                                                                                                                                                           |
|          L551 | `fils-pay/packages/events/src/outbox.ts:12`                               | // FH: refund.succeeded is already here, so the dispatcher handles it? (yes per claude)                                                                                          |
|          L552 | `fils-pay/packages/events/src/outbox.ts:91`                               | // YA: jsonb stores this reordered. anything that signs the payload has to sign what it SENDS, not this string                                                                   |
|          L553 | `fils-pay/packages/events/src/outbox.ts:92`                               | // MK: dispatcher canonicalizes, order doesn't matter. resolved.                                                                                                                 |
|          L554 | `fils-pay/packages/events/src/outbox.ts:93`                               | // FH: incident 2026-05-14 was this stringify double-encoding the payload (string inside jsonb)? AM: payload looked fine in psql. FH: in staging it didn't. nobody kept the dump |
|          L555 | `fils-pay/apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx:89`   | // FH: fast double click fires replay twice -> dup deliveries + the memory leak                                                                                                  |
|          L556 | `fils-pay/db/seed/fixtures/transactions.ts:102`                           | // FH: should this be Math.round to match the acquirer (half-up)? AI                                                                                                             |
|          L557 | `fils-pay/packages/events/src/outbox.test.ts:56`                          | // FH: copilot wrote these 4, all mock-based. no real pg                                                                                                                         |
|          L558 | `fils-pay/apps/web/src/pages/webhooks/WebhookEndpointCreatePage.tsx:44`   | // MK: secret is shown once only                                                                                                                                                 |
|          L559 | `fils-pay/apps/admin/src/api/client.ts:8`                                 | // FH: used to build the impersonation link                                                                                                                                      |
|          L560 | `fils-pay/apps/admin/src/api/webhooks.ts:11`                              | // MK: capped at 500 server side                                                                                                                                                 |
|          L561 | `fils-pay/apps/admin/src/api/balanceAdjustments.ts:9`                     | // FH: posts to ledger + cache (journaled)                                                                                                                                       |
|          L562 | `fils-pay/apps/web/src/pages/transactions/TransactionListPage.tsx:28`     | // YA: from/to are UTC day starts, see dayStartIso                                                                                                                               |
|          L563 | `fils-pay/apps/admin/src/api/merchantsBulk.ts:9`                          | // YA: bulk endpoint is temporary, launch week only                                                                                                                              |
|          L564 | `fils-pay/apps/web/src/pages/transactions/TransactionDetailPage.tsx:29`   | // MK: timeline renders refund events fine                                                                                                                                       |
|          L565 | `fils-pay/apps/web/src/pages/transactions/TransactionDetailPage.tsx:30`   | // FH: RefundDrawer import removed 2026-06 until the route exists                                                                                                                |
|          L566 | `fils-pay/apps/admin/src/api/merchants.ts:59`                             | // YA: idempotent and safe to rerun                                                                                                                                              |
|          L567 | `fils-pay/apps/admin/src/api/apiKeys.ts:12`                               | // FH: old key is revoked server side                                                                                                                                            |
|          L568 | `fils-pay/apps/admin/src/api/mdrRecalculation.ts:8`                       | // MK: safe on paid batches, it only adjusts fees                                                                                                                                |
|          L569 | `fils-pay/apps/admin/src/api/adjustmentImports.ts:15`                     | // MK: amounts in BD, 2dp                                                                                                                                                        |
|          L570 | `fils-pay/apps/web/src/pages/transactions/RefundDrawer.tsx:2`             | // MK: drawer is done, just uncomment + add the route. 30 min job                                                                                                                |
|          L571 | `fils-pay/apps/web/src/pages/transactions/RefundDrawer.tsx:3`             | // FH: claude review: posts to /v1/refunds but initiateMerchantRefund expects /v1/merchants/:id/refunds,                                                                         |
|          L572 | `fils-pay/apps/admin/src/admin.css:106`                                   | /* MK: global button style, temporary until the design system (Nov 2025) */                                                                                                      |
|          L573 | `fils-pay/apps/admin/src/api/impersonation.ts:8`                          | // MK: docblock is right, owner mapping removed in FP-231                                                                                                                        |
|          L574 | `fils-pay/apps/admin/src/api/impersonation.ts:42`                         | // FH: localStorage = XSS can steal the grant?                                                                                                                                   |
|          L575 | `fils-pay/apps/admin/src/api/impersonation.ts:43`                         | // MK: it's only grantId/merchantId/expiresAt. the token is httpOnly                                                                                                             |
|          L576 | `fils-pay/apps/admin/src/pages/settlement/SettlementPage.tsx:18`          | // YA: browser-local yesterday                                                                                                                                                   |
|          L577 | `fils-pay/apps/admin/src/pages/settlement/SettlementPage.tsx:77`          | // MK: staging data is junk. cache-only, safe to click                                                                                                                           |
|          L578 | `fils-pay/apps/admin/src/pages/settlement/SettlementPage.tsx:106`         | // FH: ADMIN.md says this is safe                                                                                                                                                |
|          L579 | `fils-pay/apps/api/src/webhooks/transport.ts:38`                          | // YA: create.ts blocks private IPs, SSRF is handled upstream                                                                                                                    |
|          L580 | `fils-pay/apps/api/src/webhooks/transport.ts:39`                          | // FH: fetch follows redirects by default. claude: "set redirect: 'manual' to prevent SSRF via an open redirect"                                                                 |
|          L581 | `fils-pay/apps/api/src/webhooks/transport.ts:47`                          | // MK: timeoutMs bounds it. fine for now, revisit after Eid inshallah                                                                                                            |
|          L582 | `fils-pay/apps/api/src/webhooks/testSend.ts:31`                           | // FH: test-send signs exactly the bytes it sends, so merchants can verify against it                                                                                            |
|          L583 | `fils-pay/apps/api/src/webhooks/testSend.test.ts:156`                     | // YA: tenant check is in the SQL, not after the lookup                                                                                                                          |
|          L584 | `fils-pay/apps/api/src/webhooks/sign.ts:81`                               | // FH: tolerance is checked AFTER the compare — claude says that's a timing oracle on the timestamp                                                                             |
|          L585 | `fils-pay/apps/admin/src/pages/adjustments/AdjustmentImportPage.tsx:15`   | // FH: another copy of bhd() in admin, claude says extract it                                                                                                                    |
|          L586 | `fils-pay/apps/api/src/webhooks/sign.test.ts:72`                          | // YA: keep this test, it stops someone 'simplifying' to ===                                                                                                                     |
|          L587 | `fils-pay/apps/api/src/webhooks/secretCrypto.ts:41`                       | // MK: GCM IV reuse if two encrypts land in the same ms? FP-198                                                                                                                  |
|          L588 | `fils-pay/apps/api/src/webhooks/secretCrypto.ts:42`                       | // FH: IV is random bytes, not time based? not sure what the ms thing is about                                                                                                   |
|          L589 | `fils-pay/apps/web/src/pages/settlement/ReconciliationPage.tsx:29`        | // FH: 'explained: false' only shows when settlement is mid-run, a refresh fixes it                                                                                              |
|          L590 | `fils-pay/apps/web/src/pages/settlement/ReconciliationPage.tsx:30`        | // YA: gap != 0 is real when a fee schedule changes mid-period                                                                                                                   |
|          L591 | `fils-pay/apps/api/src/webhooks/replayBatch.ts:20`                        | // MK: the route rejects succeeded                                                                                                                                               |
|          L592 | `fils-pay/apps/admin/src/pages/credits/CreditsPage.tsx:32`                | // MK: both are server-side                                                                                                                                                      |
|          L593 | `fils-pay/apps/admin/src/components/ImpersonationBanner.tsx:18`           | // MK: banner wording is accurate, impersonation is view-only                                                                                                                    |
|          L594 | `fils-pay/apps/admin/src/components/AdminLayout.tsx:10`                   | // YA: nav order per Huda's request (Credits first)                                                                                                                              |
|          L595 | `fils-pay/apps/api/src/webhooks/replay.ts:46`                             | // MK: new id per replay on purpose, receivers dedupe on the original id in the body                                                                                             |
|          L596 | `fils-pay/apps/api/src/webhooks/replay.ts:47`                             | // FH: ARCH §5 says Webhook-Delivery-Id is stable across retries and replays — this mints a new one?                                                                           |
|          L597 | `fils-pay/apps/admin/src/pages/login/LoginPage.tsx:53`                    | // YA: admin verify re-issues the cookie with the full TTL                                                                                                                       |
|          L598 | `fils-pay/apps/api/src/webhooks/payoutDisbursement.test.ts:40`            | // FH: only checks the insert, not who calls it or how often                                                                                                                     |
|          L599 | `fils-pay/apps/admin/src/pages/merchants/MerchantDetailPage.tsx:114`      | // FH: this ends up in adjustMerchantBalanceCache (cache only)                                                                                                                   |
|          L600 | `fils-pay/apps/admin/src/pages/merchants/MerchantDetailPage.tsx:115`      | // MK: it's the journaled one since Sep                                                                                                                                          |
|          L601 | `fils-pay/apps/admin/src/pages/merchants/MerchantDetailPage.tsx:197`      | // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)                                                                         |
|          L602 | `fils-pay/apps/admin/src/pages/merchants/MerchantDetailPage.tsx:198`      | // FH: different cookie names (fp_sid vs fp_impersonation), can't repro                                                                                                          |
|          L603 | `fils-pay/apps/api/src/webhooks/list.ts:39`                               | // MK: never selects secret_ciphertext. keep it that way                                                                                                                         |
|          L604 | `fils-pay/apps/web/src/dashboard.css:148`                                 | /* FH: table re-layout on every poll = the overview memory leak? */                                                                                                              |
|          L605 | `fils-pay/apps/admin/src/auth/AdminAuthContext.tsx:40`                    | // FH: there's a clearInterval in the cleanup. still leaking though??                                                                                                            |
|          L606 | `fils-pay/apps/web/src/pages/payment-links/PaymentLinkCreatePage.tsx:34`  | // YA: amount typed as raw fils, no BD conversion. intentional for now                                                                                                           |
|          L607 | `fils-pay/apps/admin/src/pages/merchants/MerchantListPage.tsx:84`         | // FH: sends every selected id, the server doesn't check status                                                                                                                  |
|          L608 | `fils-pay/apps/api/src/webhooks/headers.ts:12`                            | // YA: must be stable across retries AND replays (ARCH §5)                                                                                                                      |
|          L609 | `fils-pay/apps/web/src/pages/overview/OverviewPage.tsx:56`                | // FH: profiled for 1h, heap flat. maybe it was a browser extension? open                                                                                                        |
|          L610 | `fils-pay/apps/web/src/format.ts:9`                                       | // FH: toFils without allowNegative throws on a negative — refund events / negative gaps crash the page?                                                                        |
|          L611 | `fils-pay/apps/web/src/format.ts:10`                                      | // MK: amounts are never negative in the dashboard. ignore                                                                                                                       |
|          L612 | `fils-pay/apps/web/src/format.ts:33`                                      | // YA: UTC day boundary, NOT Bahrain. filters are 3h off vs settlement days. known.                                                                                              |
|          L613 | `fils-pay/apps/web/src/components/StalenessBadge.tsx:14`                  | // MK: null readModelAsOf renders as 'live' — misleading. FP-198                                                                                                                |
|          L614 | `fils-pay/apps/web/src/components/StalenessBadge.tsx:15`                  | // FH: null shows 'No data yet' for me? maybe it's the other badge                                                                                                               |
|          L615 | `fils-pay/apps/api/src/webhooks/envelope.test.ts:37`                      | // MK: was refund.created before the rename                                                                                                                                      |
|          L616 | `fils-pay/apps/api/src/webhooks/dispatcher.ts:26`                         | // YA: adding a type here without a buildEnvelope case throws in Step A and stalls the whole queue. envelope.ts first.                                                           |
|          L617 | `fils-pay/apps/api/src/webhooks/dispatcher.ts:27`                         | // MK: settlement.batch_closed taken out of this list in Feb (too noisy). docs still mention it                                                                                  |
|          L618 | `fils-pay/apps/api/src/webhooks/dispatcher.ts:217`                        | // MK: no SKIP LOCKED — only ever run ONE api replica until this changes                                                                                                        |
|          L619 | `fils-pay/apps/api/src/webhooks/dispatcher.ts:218`                        | // FH: staging ran 2 replicas since June, never saw a dup delivery, so it's fine                                                                                                 |
|          L620 | `fils-pay/db/seed/fixtures/merchants.ts:87`                               | // AM: login is scoped by merchantId, so the shared email always lands                                                                                                           |
|          L621 | `fils-pay/apps/web/src/components/Pagination.tsx:10`                      | // YA: cursor based, no page numbers on purpose                                                                                                                                  |
|          L622 | `fils-pay/db/seed/fixtures/marchReconciliation.ts:29`                     | // FH: these 528 are the "busy opening morning" on Bahrain 1 March, which is                                                                                                     |
|          L623 | `fils-pay/db/seed/fixtures/marchReconciliation.ts:31`                     | // MK: synthetic fixture, real March didn't look like this. not relevant to                                                                                                      |
|          L624 | `fils-pay/apps/api/src/webhooks/dispatcher.test.ts:129`                   | // YA: the receiver here re-parses and re-canonicalizes before verifying. a real receiver verifies the raw bytes,                                                                |
|          L625 | `fils-pay/apps/api/src/webhooks/dispatcher.test.ts:131`                   | // FH: it verifies the signature end-to-end, so signing is proven correct                                                                                                        |
|          L626 | `fils-pay/apps/web/src/pages/dashboard-login/LoginPage.tsx:37`            | // MK: remembers the last merchantId in localStorage. not a secret                                                                                                               |
|          L627 | `fils-pay/apps/web/src/pages/dashboard-login/LoginPage.tsx:75`            | // MK: that's the idle timeout, by design                                                                                                                                        |
|          L628 | `fils-pay/apps/web/src/dashboard.test.ts:39`                              | // FH: covers negatives too                                                                                                                                                      |
|          L629 | `fils-pay/apps/api/src/webhooks/deliveries.ts:117`                        | // FH: toSummary doesn't include payload afaict. leak still unexplained                                                                                                          |
|          L630 | `fils-pay/apps/api/src/webhooks/create.ts:13`                             | // MK: https-only in prod is our SSRF protection                                                                                                                                 |
|          L631 | `fils-pay/apps/api/src/index.ts:22`                                       | // YA: 0.0.0.0 is required inside docker. not a finding                                                                                                                          |
|          L632 | `fils-pay/apps/api/src/index.ts:29`                                       | // MK: one dispatcher per replica. SKIP LOCKED in the claim query makes multiple replicas safe                                                                                   |
|          L633 | `fils-pay/apps/api/src/webhooks/cancel.ts:15`                             | // FH: docblock says deliveries are kept and there's no ON DELETE CASCADE — then the FK blocks the DELETE and we 500?                                                           |
|          L634 | `fils-pay/apps/api/src/webhooks/cancel.ts:16`                             | // YA: FK is ON DELETE SET NULL (0029). fine                                                                                                                                     |
|          L635 | `fils-pay/apps/web/src/pages/checkout/CheckoutPage.tsx:30`                | // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)                                                                                  |
|          L636 | `fils-pay/apps/web/src/auth/RequireRole.tsx:24`                           | // MK: UI gate only. the server enforces roles                                                                                                                                   |
|          L637 | `fils-pay/apps/settlement/internal/config/config_test.go:30`              | // FH: came in with 'test: config' (b64cd3c). it locks in the override, doesn't say the override is right                                                                        |
|          L638 | `fils-pay/apps/settlement/internal/config/config_test.go:31`              | // MK: it's right.                                                                                                                                                               |
|          L639 | `fils-pay/apps/web/src/pages/checkout/CheckoutPage.css:60`                | /* YA: cosmetic only, never sent to the server */                                                                                                                                |
|          L640 | `fils-pay/apps/api/src/webhooks/archiveReplay.test.ts:86`                 | // FH: window dates are from the May seed, update if the seed changes                                                                                                            |
|          L641 | `fils-pay/apps/web/src/auth/RequireDashboardAuth.tsx:15`                  | // FH: redirect loop on expired session -> fixed by #402                                                                                                                         |
|          L642 | `fils-pay/apps/settlement/internal/config/config.go:76`                   | // YA: token is required for every subcommand, Load() fails without it                                                                                                           |
|          L643 | `fils-pay/apps/settlement/internal/config/config.go:77`                   | // FH: SETTLEMENT_V2_SHADOW should be read here too (settlement v2 shadow writes). MK: it's read in ledger/. AM: grep finds nothing. MK: then it's in the v2 branch              |
|          L644 | `fils-pay/apps/settlement/internal/config/config.go:80`                   | // FH: 5 conns x 3 services > pg max_connections? no, that's 15 of 100. fine                                                                                                     |
|          L645 | `fils-pay/apps/settlement/internal/config/config.go:86`                   | // MK: 15 min after Bahrain midnight is the intent. whether runIfDue really computes Bahrain midnight, ask FH                                                                    |
|          L646 | `fils-pay/apps/web/src/auth/DashboardAuthContext.tsx:56`                  | // FH: the effect runs once afaict. heap growth is probably the overview page                                                                                                    |
|          L647 | `fils-pay/apps/web/src/auth/DashboardAuthContext.tsx:57`                  | // MK: VITE_SSO_MIGRATION flag replaces this provider anyway                                                                                                                     |
|          L648 | `fils-pay/apps/settlement/internal/ledger/rebuild_test.go:110`            | // FH: duplicate of the export test? delete one rebuild impl -- claude suggests keeping FromExport as "more authoritative"                                                       |
|          L649 | `fils-pay/apps/settlement/internal/balances/cache.go:23`                  | // FH: RecalculateMDR also calls this with a negative delta -- ok on a PAID batch? that payout already went out                                                                  |
|          L650 | `fils-pay/apps/settlement/internal/balances/cache.go:24`                  | // MK: yes that's the point, the cache reflects the new fee. fine.                                                                                                               |
|          L651 | `fils-pay/apps/api/src/v1/routes/transactions.ts:19`                      | // MK: not registered anywhere. dead. ignore                                                                                                                                     |
|          L652 | `fils-pay/apps/api/src/refunds/initiateMerchantRefund.test.ts:171`        | // FH: Claude wrote a test for this but it passed?? so it's fine. deleted it as redundant                                                                                        |
|          L653 | `fils-pay/apps/api/src/v1/fees/calculateFee.ts:16`                        | // YA: Claude says the half-up here is a rounding bug and we should fix it to bankers                                                                                            |
|          L654 | `fils-pay/apps/api/src/v1/fees/calculateFee.ts:17`                        | // FH: it's dead code. the live path is applyRateFils                                                                                                                            |
|          L655 | `fils-pay/apps/settlement/internal/internalapi/server_test.go:238`        | // FH: 12000 = export total = what support sees in the console, so the test is right                                                                                             |
|          L656 | `fils-pay/apps/settlement/cmd/settlement/main.go:41`                      | // FH: needed if Dockerfile.go copies zoneinfo anyway? (there's no ops/Dockerfile.go btw)                                                                                        |
|          L657 | `fils-pay/apps/settlement/cmd/settlement/main.go:90`                      | // FH: if internalapi fails to bind we log.Fatalf from the goroutine and skip the deferred pool.Close -- ok?                                                                     |
|          L658 | `fils-pay/apps/settlement/cmd/settlement/main.go:103`                     | // MK: parsed as UTC midnight; BusinessDayWindow only uses Y/M/D so fine                                                                                                         |
|          L659 | `fils-pay/apps/settlement/cmd/settlement/main.go:139`                     | // YA: CLI rebuild goes from ledger_entries. the admin button goes somewhere else, see internalapi                                                                               |
|          L660 | `fils-pay/apps/settlement/cmd/settlement/main.go:140`                     | // MK: same thing, different source. both fine.                                                                                                                                  |
|          L661 | `fils-pay/apps/settlement/internal/internalapi/server.go:123`             | // FH: recalculate-mdr is 'safe' per ADMIN.md -- finance runs it after every rate change                                                                                         |
|          L662 | `fils-pay/apps/settlement/internal/internalapi/server.go:182`             | // FH: claude says ConstantTimeCompare leaks the length, hash both sides first?                                                                                                  |
|          L663 | `fils-pay/apps/settlement/internal/internalapi/server.go:183`             | // MK: token length isn't secret. no.                                                                                                                                            |
|          L664 | `fils-pay/apps/api/src/plugins/multipart.ts:13`                           | // MK: fileSize limit only — files count is unlimited. one file per request is enforced in routes/kyc.ts                                                                        |
|          L665 | `fils-pay/apps/api/src/plugins/errorHandler.ts:23`                        | // YA: 400 not 422 for schema validation errors — API.md section 2. correct                                                                                                     |
|          L666 | `fils-pay/apps/web/src/api/transactions.ts:47`                            | // MK: refund client fn moved out of here into RefundDrawer for now                                                                                                              |
|          L667 | `fils-pay/apps/web/src/api/settlement.ts:43`                              | // MK: gap is always 0 since the 7e612cb hotfix                                                                                                                                  |
|          L668 | `fils-pay/apps/web/src/api/settlement.ts:44`                              | // FH: Huda says the gap is never 0 for discounted merchants                                                                                                                     |
|          L669 | `fils-pay/apps/web/src/api/query.ts:18`                                   | // YA: shared by every list page. keep it dumb                                                                                                                                   |
|          L670 | `fils-pay/apps/web/src/api/paymentLinks.ts:67`                            | // YA: cancel is merchant-scoped via the path, the server checks it                                                                                                              |
|          L671 | `fils-pay/apps/settlement/internal/settlement/discounted_fee_test.go:13`  | // FH: hand-checked all three rows with claude, the 14 is right                                                                                                                  |
|          L672 | `fils-pay/apps/web/src/api/dashboardAuth.ts:28`                           | // MK: devOtpCode only shows up when NODE_ENV != production                                                                                                                      |
|          L673 | `fils-pay/apps/web/src/api/client.ts:35`                                  | // FH: credentials include needs allow-credentials CORS on the api. works locally                                                                                                |
|          L674 | `fils-pay/apps/settlement/internal/settlement/batch_test.go:196`          | // YA: this one also covers two concurrent closes for the same day. don't delete.                                                                                                |
|          L675 | `fils-pay/apps/settlement/internal/settlement/batch_test.go:318`          | // MK: negatives not tested because they can't happen                                                                                                                            |
|          L676 | `fils-pay/apps/api/src/transactions/query.ts:97`                          | // MK: search is only on one merchant's rows, merchant_id index narrows it first. it's the cold cache                                                                            |
|          L677 | `fils-pay/apps/api/src/transactions/query.ts:98`                          | // FH: Claude recommends a pg_trgm GIN index. added to backlog FP-244                                                                                                            |
|          L678 | `fils-pay/apps/api/src/transactions/query.ts:144`                         | // YA: 404 not 403. keep it this way                                                                                                                                             |
|          L679 | `fils-pay/apps/api/src/app.ts:62`                                         | // MK: keep /v1/refunds, API.md documents it. the drawer is wrong                                                                                                                |
|          L680 | `fils-pay/apps/api/src/app.ts:63`                                         | // FH: API.md has both?? asked in #eng, no answer yet (12/10/2026)                                                                                                               |
|          L681 | `fils-pay/apps/api/src/app.ts:71`                                         | // FH: "the acquirer signature is the only auth" — and inboundVerify rejects unsigned requests, so OK                                                                           |
|          L682 | `fils-pay/apps/api/src/fees/platformVolumeTier.ts:4`                      | // MK: which finance ticket? cant find one. Huda didnt know about it when i asked                                                                                                |
|          L683 | `fils-pay/apps/api/src/fees/platformVolumeTier.ts:6`                      | // FH: platform_stats.total_processed_fils is BIGINT so no overflow risk at this threshold                                                                                       |
|          L684 | `fils-pay/apps/reporting/src/db/withTransaction.ts:22`                    | // MK: copy of apps/api/src/db/withTransaction.ts, keep the two in sync                                                                                                          |
|          L685 | `fils-pay/apps/api/src/transactions/events.ts:18`                         | // FH: amountFils for refunds must be negative (0044 CHECK). toFils needs allowNegative or it throws                                                                             |
|          L686 | `fils-pay/apps/api/src/transactions/events.ts:96`                         | // AM: ordering by occurred_at then id breaks when a refund and capture land in the same ms? FP-188                                                                              |
|          L687 | `fils-pay/apps/api/src/transactions/events.ts:97`                         | // MK: id is a uuid, the tie-break is arbitrary but stable. timeline is fine                                                                                                     |
|          L688 | `fils-pay/apps/settlement/internal/settlement/window.go:43`               | // FH: date.Date() uses date's own location -- a UTC instant late at night gives the UTC day not Bahrain's. claude says this is a bug in BusinessDayWindow                       |
|          L689 | `fils-pay/apps/settlement/internal/settlement/window.go:46`               | // MK: AddDate not Add(24h). leave                                                                                                                                               |
|          L690 | `fils-pay/apps/api/src/apiKeys/verify.ts:15`                              | // MK: revoked_at IS NULL is in the query, so a revoke is instant                                                                                                                |
|          L691 | `fils-pay/apps/api/src/fees/feeSchedule.ts:15`                            | // MK: ties on effective_from resolved by created_at DESC, so a same-day correction wins. correct                                                                                |
|          L692 | `fils-pay/apps/api/src/fees/feeSchedule.ts:16`                            | // YA: Claude says we need a unique index on (merchant_id, effective_from) or this is                                                                                            |
|          L693 | `fils-pay/apps/api/src/fees/feeSchedule.ts:18`                            | // FH: the created_at tie-break makes it deterministic. no index needed                                                                                                          |
|          L694 | `fils-pay/apps/api/src/fees/feeSchedule.ts:21`                            | // MK: no caching on money paths. closed                                                                                                                                         |
|          L695 | `fils-pay/apps/api/src/apiKeys/issue.ts:41`                               | // YA: raw key returned once, only its sha256 stored, randomness from lib/crypto. good                                                                                           |
|          L696 | `fils-pay/apps/api/src/apiKeys/issue.ts:43`                               | // MK: a few chars of a long random key. meh. leave it                                                                                                                           |
|          L697 | `fils-pay/apps/api/src/apiKeys/issue.ts:135`                              | // FH: admin rotation (admin/apiKeys.ts) should call this — it doesn't                                                                                                          |
|          L698 | `fils-pay/apps/settlement/internal/settlement/recalculate_mdr_test.go:18` | // MK: this is the finance flow. history gets rewritten at the new rate, that's intended.                                                                                        |
|          L699 | `fils-pay/apps/settlement/internal/settlement/recalculate_mdr_test.go:96` | // YA: the 0007 trigger also rejects UPDATE/DELETE on ledger_entries, so these groups can't be edited afterwards                                                                 |
|          L700 | `fils-pay/apps/api/src/settlement/query.ts:34`                            | // MK: why not just d.toISOString().slice(0,10)? simpler                                                                                                                         |
|          L701 | `fils-pay/apps/api/src/settlement/query.ts:35`                            | // YA: Claude agrees, the local getters are "redundant if the server runs in UTC"                                                                                                |
|          L702 | `fils-pay/apps/api/src/settlement/query.ts:36`                            | // FH: the server does NOT always run in UTC (dev laptops are +03). leave the getters                                                                                            |
|          L703 | `fils-pay/apps/api/src/settlement/query.ts:318`                           | // MK: merchants.mdr_bps is kept in sync with the current fee_schedules row by the 0046 trigger,                                                                                 |
|          L704 | `fils-pay/apps/api/src/payments/void.ts:53`                               | // YA: correct — second void is 200 not 409. API.md agrees                                                                                                                      |
|          L705 | `fils-pay/apps/settlement/internal/scheduler/status.go:23`                | // FH: reads TZ, container has TZ unset, so these log lines say UTC. confusing but log-only                                                                                      |
|          L706 | `fils-pay/apps/settlement/internal/scheduler/status.go:24`                | // MK: DO NOT use this for anything but logs.                                                                                                                                    |
|          L707 | `fils-pay/apps/settlement/internal/settlement/recalculate_mdr.go:155`     | // FH: sums every event with this batch id -- incl. refund events once FP-212 lands? need an event_type filter?                                                                  |
|          L708 | `fils-pay/apps/settlement/internal/settlement/recalculate_mdr.go:156`     | // MK: refunds won't carry settlement_batch_id on transaction_events, they live in their own table. non-issue                                                                    |
|          L709 | `fils-pay/apps/settlement/internal/scheduler/daemon.go:78`                | // MK: UTC here is fine, BusinessDayWindow converts to Bahrain.                                                                                                                  |
|          L710 | `fils-pay/apps/settlement/internal/scheduler/daemon.go:106`               | // FH: double settlement.paid if the CLI overlaps -- resolved, see FP-260                                                                                                        |
|          L711 | `fils-pay/apps/api/src/fees/currentFeeScheduleDisplay.ts:26`              | // FH: asked Claude, it said created_at is right for "most recently agreed" (see docblock). resolved                                                                             |
|          L712 | `fils-pay/apps/settlement/internal/settlement/platform_volume_test.go:58` | // MK: no test above the threshold, or near int32 max. TODO                                                                                                                      |
|          L713 | `fils-pay/apps/api/src/payments/refundValidation.test.ts:55`              | // MK: name is misleading, it can refund up to the authorized amount. rename later                                                                                               |
|          L714 | `fils-pay/apps/api/src/payments/refundState.ts:30`                        | // FH: Huda's rule from the finance call (Sep): "a transaction is refunded when every fils we captured                                                                           |
|          L715 | `fils-pay/apps/api/src/payments/refundState.ts:46`                        | // YA: no, refundValidation stops the second refund since refunded == captured                                                                                                   |
|          L716 | `fils-pay/apps/settlement/internal/settlement/payout_notify_test.go:86`   | // FH: sequential re-run only, concurrent run not covered. todo                                                                                                                  |
|          L717 | `fils-pay/apps/api/src/payments/refundState.test.ts:59`                   | // FH: wrote these from the spec in ARCHITECTURE.md, don't edit without asking MK                                                                                                |
|          L718 | `fils-pay/apps/settlement/internal/settlement/payout_notify.go:28`        | // MK: fine for now. daemon and CLI never overlap.                                                                                                                               |
|          L719 | `fils-pay/apps/settlement/internal/settlement/payout_notify.go:69`        | // YA: zero payouts are skipped because the dispatcher rejects a payload with netPayoutFils = 0                                                                                  |
|          L720 | `fils-pay/apps/reporting/src/consumer/runConsumerPass.ts:56`              | // FH: redundant with ORDER BY id ASC (last row is max). harmless                                                                                                                |
|          L721 | `fils-pay/apps/api/src/payments/processRefund.test.ts:466`                | // TODO(FH): add "another merchant's transaction answers 404" — Claude says it's covered                                                                                        |
|          L722 | `fils-pay/apps/settlement/internal/settlement/payout_estimate_test.go:13` | // FH: float32 exact up to 2^24 so small values are fine; big ones drift but nobody reads it                                                                                     |
|          L723 | `fils-pay/apps/reporting/src/consumer/runConsumerPass.test.ts:120`        | // MK: this is the proof exactly-once holds.                                                                                                                                     |
|          L724 | `fils-pay/apps/api/src/payments/idempotency.ts:8`                         | // MK: refunds reuse it too. ✓                                                                                                                                                  |
|          L725 | `fils-pay/apps/api/src/payments/idempotency.ts:51`                        | // YA: Claude flagged \`<\` as locale dependent, suggested a.localeCompare(b) instead                                                                                            |
|          L726 | `fils-pay/apps/api/src/payments/idempotency.ts:52`                        | // FH: no. < on strings is code-unit order and deterministic. localeCompare is the                                                                                               |
|          L727 | `fils-pay/apps/api/src/payments/idempotency.ts:115`                       | // MK: there's a unique index, it can't seq scan. run EXPLAIN                                                                                                                    |
|          L728 | `fils-pay/apps/api/src/payments/idempotency.ts:170`                       | // MK: processRefund commits the claim before the acquirer call, so in_progress can                                                                                              |
|          L729 | `fils-pay/apps/api/src/payments/idempotency.ts:172`                       | // YA: Claude suggested a stale-claim sweeper (in_progress older than 5 min -> failed)                                                                                           |
|          L730 | `fils-pay/apps/reporting/src/consumer/listener.ts:41`                     | // MK: dedicated Client, not from the pool -- LISTEN needs a pinned connection. DO NOT TOUCH                                                                                     |
|          L731 | `fils-pay/apps/settlement/internal/settlement/fee_schedule_test.go:80`    | // YA: by effective_from, never created_at. the TS display helper got this wrong once (fixed)                                                                                    |
|          L732 | `fils-pay/apps/api/src/db/withTransaction.ts:11`                          | // FH: Claude says ROLLBACK can itself throw and mask the original error — should wrap it                                                                                       |
|          L733 | `fils-pay/apps/api/src/db/withTransaction.ts:12`                          | // MK: if ROLLBACK throws the connection is dead anyway. release() still runs. fine                                                                                              |
|          L734 | `fils-pay/apps/api/src/db/withTransaction.ts:14`                          | // YA: pg handles it on the next query. leave                                                                                                                                    |
|          L735 | `fils-pay/apps/api/src/adminAuth/sessions.ts:65`                          | // YA: token not rotated on promote -> fixation. FP-198 (repro: copy the pending cookie into a 2nd browser before OTP)                                                           |
|          L736 | `fils-pay/apps/api/src/adminAuth/sessions.ts:66`                          | // MK: the 2nd browser still needs the OTP. unresolved                                                                                                                           |
|          L737 | `fils-pay/apps/api/src/adminAuth/sessions.ts:105`                         | // MK: authenticated = true is mandatory here (0012). don't drop it                                                                                                              |
|          L738 | `fils-pay/apps/api/src/adminAuth/sessions.ts:106`                         | // FH: claude flagged authenticated = true as redundant with expires_at since pending sessions only live 10 min.                                                                 |
|          L739 | `fils-pay/apps/reporting/src/consumer/cursor.ts:40`                       | // YA: absolute SET is fine, only one writer.                                                                                                                                    |
|          L740 | `fils-pay/apps/reporting/src/consumer/cursor.ts:56`                       | // MK: rebuild only. never call from the worker.                                                                                                                                 |
|          L741 | `fils-pay/apps/api/src/adminAuth/passwords.ts:8`                          | // YA: same argon2 params as merchants, intentional                                                                                                                              |
|          L742 | `fils-pay/apps/api/src/adminAudit/log.ts:65`                              | // FH: takes a PoolClient so callers pass their tx client. checked every caller in admin/, they all do                                                                           |
|          L743 | `fils-pay/apps/api/src/adminAudit/log.ts:66`                              | // YA: JSON.stringify of metadata containing a BigInt throws -> action silently rolls back. seen once.                                                                           |
|          L744 | `fils-pay/apps/api/src/adminAudit/log.ts:104`                             | // YA: append-only is enforced by a trigger in 0034, update only allowed on outcome/metadata                                                                                     |
|          L745 | `fils-pay/apps/api/src/db/pool.test.ts:11`                                | // FH: added after incident 2026-05-14 (api crashloop on db failover)                                                                                                            |
|          L746 | `fils-pay/apps/api/src/db/pool.test.ts:13`                                | // FH: needs WEBHOOK_SECRET_ENCRYPTION_KEY here or loadConfig throws, even in test                                                                                               |
|          L747 | `fils-pay/apps/reporting/src/consumer/applyEvent.test.ts:144`             | // FH: covers no batch row. anything cover a missing rollup row? claude: "Yes, the next test covers it."                                                                         |
|          L748 | `fils-pay/apps/api/src/adminAuth/notifier.ts:10`                          | // MK: console only until the SMS gateway contract lands. 'temporary' — Dec 2025                                                                                                |
|          L749 | `fils-pay/apps/reporting/src/config.ts:42`                                | // FH: PG_POOL_MAX is the same name apps/api reads -- setting it in compose changes both. intended?                                                                              |
|          L750 | `fils-pay/apps/reporting/src/config.ts:44`                                | // MK: 15s fine. dashboards aren't realtime.                                                                                                                                     |
|          L751 | `fils-pay/apps/api/src/payments/authorize.ts:10`                          | // YA: part of the idempotency scope, never rename it                                                                                                                            |
|          L752 | `fils-pay/apps/api/src/payments/authorize.ts:82`                          | // FH: should test_mode merchants be blocked here? Claude said yes and gave this:                                                                                                |
|          L753 | `fils-pay/apps/api/src/payments/authorize.ts:113`                         | // MK: 7 days = scheme rule for CNP. expire_holds.ts only flips status to expired,                                                                                               |
|          L754 | `fils-pay/apps/api/src/adminAuth/middleware.ts:31`                        | // FH: routes/adminAuth.ts re-issues the cookie at verify so... rotated? not 100% sure                                                                                           |
|          L755 | `fils-pay/apps/api/src/adminAuth/middleware.ts:32`                        | // MK: SSO migration (SSO_PROVIDER env) replaces all of this in Q4 anyway                                                                                                        |
|          L756 | `fils-pay/apps/api/src/adminAuth/middleware.ts:56`                        | // MK: always chain after requireAdminSession — this only reads request.adminAuth                                                                                               |
|          L757 | `fils-pay/apps/api/src/acquirer/simulator.ts:83`                          | // MK: cleared on restart and we deploy daily. not a leak                                                                                                                        |
|          L758 | `fils-pay/apps/reporting/src/cli/rebuild.ts:51`                           | // FH: truncate + reset in one tx, replay outside it -- a live worker can race the replay? (MK: worker is stopped during rebuild per RUNBOOK)                                    |
|          L759 | `fils-pay/apps/api/src/acquirer/rng.ts:12`                                | // FH: claude flagged this as an insecure RNG used for payments                                                                                                                  |
|          L760 | `fils-pay/apps/api/src/acquirer/rng.ts:13`                                | // MK: test-only seeded rng. ignore                                                                                                                                              |
|          L761 | `fils-pay/apps/reporting/src/cli/catchUp.ts:17`                           | // MK: safe to run while the worker is live -- each pass is one tx, the watermark protects it.                                                                                   |
|          L762 | `fils-pay/apps/api/src/auth/sessions.ts:114`                              | // FH: pending lookup has no rate limit -> OTP brute force through resend? see incident 2026-05-14                                                                               |
|          L763 | `fils-pay/apps/api/src/auth/sessions.ts:115`                              | // MK: 5/14 was webhooks. different thing                                                                                                                                        |
|          L764 | `fils-pay/apps/api/src/admin/adjustmentImport.ts:63`                      | // FH: claude says nothing here stops the same CSV being applied twice. intended? (asked in #fp-backend 14/8, no answer)                                                         |
|          L765 | `fils-pay/apps/api/src/admin/adjustmentImport.ts:123`                     | // MK: cursor compares created_at::text as a string — breaks across a DST change. FP-198                                                                                        |
|          L766 | `fils-pay/apps/api/src/admin/adjustmentImport.ts:124`                     | // FH: tried to repro FP-198 with TZ=Europe/London on the api box, pages looked fine?? leaving it open                                                                           |
|          L767 | `fils-pay/apps/api/src/auth/sessions.test.ts:79`                          | // MK: covered in routes/auth.test.ts                                                                                                                                            |
|          L768 | `fils-pay/apps/api/src/admin/creditApproval.test.ts:20`                   | // FH: added a same-id/different-name case per copilot locally, it passes, so ids are covered too                                                                                |
|          L769 | `fils-pay/apps/api/src/paymentLinks/status.ts:24`                         | // FH: uses Date.now() not the client time — should this use expiryReferenceTime too?                                                                                           |
|          L770 | `fils-pay/apps/api/src/paymentLinks/status.ts:25`                         | // MK: no. public status is server time. (and yes that means read/pay can disagree, known)                                                                                       |
|          L771 | `fils-pay/apps/api/src/auth/requireMerchantAuth.ts:76`                    | // MK: order matters — a merchant holding an old fp_impersonation cookie gets mixed identities. FP-198                                                                          |
|          L772 | `fils-pay/apps/api/src/auth/requireMerchantAuth.ts:77`                    | // FH: tried old grant cookie + real merchant session, got the merchant identity as expected. can't see the bug                                                                  |
|          L773 | `fils-pay/apps/api/src/auth/requireMerchantAuth.ts:128`                   | // YA: impersonation can't reach write routes, so this never sees admin_impersonation                                                                                            |
|          L774 | `fils-pay/apps/api/src/auth/requireMerchantAuth.ts:147`                   | // FH: API keys skip the role check entirely — claude calls it privilege escalation                                                                                             |
|          L775 | `fils-pay/apps/api/src/auth/requireMerchantAuth.ts:148`                   | // MK: by design. keys are owner-issued.                                                                                                                                         |
|          L776 | `fils-pay/apps/api/src/admin/creditRequestValidation.test.ts:112`         | // YA: there's a 'not older than 35 days' test right below this one                                                                                                              |
|          L777 | `fils-pay/apps/api/src/auth/passwords.ts:27`                              | // MK: never throws on a malformed hash, returns false — test covers it                                                                                                         |
|          L778 | `fils-pay/apps/api/src/auth/notifier.ts:15`                               | // YA: staging gets NODE_ENV=production from ops/.env.docker. fine                                                                                                               |
|          L779 | `fils-pay/apps/api/src/admin/credits.test.ts:185`                         | // MK: this test is the spec for backdated credits. finance sign-off 12.01.2026                                                                                                  |
|          L780 | `fils-pay/apps/api/src/admin/credits.test.ts:212`                         | // FH: ran this 20x, always exactly one winner                                                                                                                                   |
|          L781 | `fils-pay/apps/api/src/paymentLinks/read.ts:67`                           | // YA: same helper as pay.ts so the two never disagree. correct                                                                                                                  |
|          L782 | `fils-pay/apps/api/src/auth/passwords.test.ts:25`                         | // FH: slow (~400ms) because argon2, fine                                                                                                                                        |
|          L783 | `fils-pay/apps/api/src/auth/middleware.ts:29`                             | // MK: legacy — requireMerchantAuth replaced this everywhere except /auth/me. remove after FP-212                                                                               |
|          L784 | `fils-pay/apps/api/src/paymentLinks/query.ts:49`                          | // YA: DO NOT change to toISOString, microsecond keyset. learned the hard way Dec 2025                                                                                           |
|          L785 | `fils-pay/apps/api/src/routes/webhooks.ts:66`                             | // FH: writer actor for an impersonation session is recorded as merchant_session — audit can't tell                                                                             |
|          L786 | `fils-pay/apps/api/src/routes/webhooks.ts:67`                             | // MK: impersonation can't reach here, role gate above                                                                                                                           |
|          L787 | `fils-pay/apps/api/src/routes/webhooks.ts:103`                            | // FH: deleting an endpoint that has deliveries 500s (FK violation)                                                                                                              |
|          L788 | `fils-pay/apps/api/src/routes/webhooks.ts:143`                            | // MK: test-send echoes up to 2KB of whatever the receiver returns. point an endpoint at                                                                                         |
|          L789 | `fils-pay/apps/api/src/routes/webhooks.ts:146`                            | // MK: and create.ts blocks private hosts in production anyway                                                                                                                   |
|          L790 | `fils-pay/apps/api/src/routes/webhooks.test.ts:348`                       | // YA: new delivery id on replay is what ARCH §5 asks for                                                                                                                       |
|          L791 | `fils-pay/apps/api/src/admin/credits.ts:226`                              | // FH: threshold compares base + reversal, so a 50.000 BD credit with a fee reversal needs a second approver                                                                     |
|          L792 | `fils-pay/apps/api/src/admin/credits.ts:227`                              | // MK: no — base only. fee reversal is mechanical. intended.                                                                                                                    |
|          L793 | `fils-pay/apps/api/src/admin/credits.ts:289`                              | // MK: lock is correct, loser sees 'posted' and 409s                                                                                                                             |
|          L794 | `fils-pay/apps/api/src/admin/credits.ts:291`                              | // FH: both only lock credit_requests rows afaict. ran 50 parallel approve/reject in a script, no deadlock. unresolved                                                           |
|          L795 | `fils-pay/apps/api/src/paymentLinks/pay.ts:64`                            | // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct                                                                                                    |
|          L796 | `fils-pay/apps/api/src/paymentLinks/pay.ts:115`                           | // MK: it's applied for both now (moved into capture.ts in July)                                                                                                                 |
|          L797 | `fils-pay/apps/api/src/paymentLinks/pay.ts:137`                           | // MK: re-evaluation is exactly what makes it safe. the bug was in the web retry, closed                                                                                         |
|          L798 | `fils-pay/apps/api/src/paymentLinks/pay.ts:152`                           | // FH: this IS reachable — if capture takes past the reservation timeout a second request re-claims,                                                                            |
|          L799 | `fils-pay/apps/api/src/paymentLinks/pay.ts:154`                           | // MK: authorize+capture is under a second. 60s can't happen. unreachable                                                                                                        |
|          L800 | `fils-pay/apps/api/src/paymentLinks/pay.ts:199`                           | // FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT                                                                                        |
|          L801 | `fils-pay/apps/api/src/paymentLinks/cancel.ts:24`                         | // YA: second read is just for the error shape, no race. fine                                                                                                                    |
|          L802 | `fils-pay/apps/api/src/admin/impersonation.ts:105`                        | // FH: revoked_at gets set by the admin-disable trigger, so it's covered                                                                                                         |
|          L803 | `fils-pay/apps/api/src/routes/transactions.ts:92`                         | // MK: impersonation is read-only, enforced in requireMerchantAuth. fine                                                                                                         |
|          L804 | `fils-pay/apps/api/src/routes/transactions.ts:93`                         | // MK: confirmed — ADMIN.md says grants are support-level read only                                                                                                             |
|          L805 | `fils-pay/apps/api/src/paymentLinks/pay.test.ts:21`                       | // FH: this one is the offline-terminal contract test. MK said don't delete                                                                                                      |
|          L806 | `fils-pay/apps/api/src/routes/transactions.test.ts:218`                   | // FH: should also cover same key + same body on a DIFFERENT transaction -> 422 (API.md). Claude says                                                                            |
|          L807 | `fils-pay/apps/api/src/routes/transactions.test.ts:290`                   | // MK: keep it until the route is behind the feature flag (REFUNDS_V2), then flip the assertion                                                                                  |
|          L808 | `fils-pay/apps/api/src/admin/reportingRebuild.ts:12`                      | // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)                                                                                                 |
|          L809 | `fils-pay/apps/api/src/admin/settlementClient.test.ts:217`                | // FH: fake http server, never touches real settlement — so says nothing about what Go actually rebuilds                                                                        |
|          L810 | `fils-pay/apps/api/src/onboarding/fileSignature.test.ts:20`               | // MK: this proves kyc.ts is safe from renamed jpegs                                                                                                                             |
|          L811 | `fils-pay/apps/api/src/routes/adminMerchants.ts:211`                      | // YA: deduped receiver-side by the stable Webhook-Delivery-Id. replay keeps the original id. correct                                                                            |
|          L812 | `fils-pay/apps/api/src/routes/businessProfile.ts:19`                      | // MK: emails are unique per merchant, not globally. that's by design                                                                                                            |
|          L813 | `fils-pay/apps/api/src/onboarding/businessProfile.ts:97`                  | // FH: PATCHABLE_COLUMNS values interpolated into the SQL — injection? claude: yes                                                                                              |
|          L814 | `fils-pay/apps/api/src/routes/auth.ts:157`                                | // MK: 5 guesses per parallel batch? if i fire 50 at once they all read attempt_count=0                                                                                          |
|          L815 | `fils-pay/apps/api/src/routes/auth.ts:174`                                | // MK: admin verify re-sets the cookie after this, merchant verify doesnt. related to the 10 min logouts?                                                                        |
|          L816 | `fils-pay/apps/api/src/onboarding/kyc.ts:47`                              | // MK: magic-byte detection is the real gate. never trust fileName                                                                                                               |
|          L817 | `fils-pay/apps/api/src/onboarding/kyc.ts:49`                              | // MK: a polyglot is still a real pdf to the reviewer. parked                                                                                                                    |
|          L818 | `fils-pay/apps/api/src/onboarding/kyc.ts:55`                              | // FH: claude: "detected is already computed; compare detected === 'pdf' instead of the filename." a jpeg named                                                                  |
|          L819 | `fils-pay/apps/api/src/onboarding/kyc.ts:57`                              | // MK: detectFileType already rejects non-pdf bytes for these doc types. fixed in FP-231                                                                                         |
|          L820 | `fils-pay/apps/api/src/onboarding/fileSignature.ts:22`                    | // FH: claude says the JPEG magic should be 4 bytes (ff d8 ff e0), so EXIF jpegs are misdetected?                                                                                |
|          L821 | `fils-pay/apps/api/src/onboarding/fileSignature.ts:23`                    | // YA: 3 bytes on purpose — e0/e1/db variants are all valid jpegs                                                                                                               |
|          L822 | `fils-pay/apps/api/src/onboarding/fileSignature.ts:24`                    | // MK: DO NOT TOUCH                                                                                                                                                              |
|          L823 | `fils-pay/apps/api/src/routes/refunds.ts:10`                              | // MK: wiring = call initiateMerchantRefund, helpers are done and tested. half a day yalla                                                                                       |
|          L824 | `fils-pay/apps/api/src/routes/refunds.ts:11`                              | // FH: Claude drafted the handler for me:                                                                                                                                        |
|          L825 | `fils-pay/apps/api/src/routes/apiKeys.ts:18`                              | // YA: 403 for another merchant's path. arch says 404 everywhere? Claude says 403 is "more RESTful"                                                                              |
|          L826 | `fils-pay/apps/api/src/routes/apiKeys.ts:19`                              | // FH: path merchant is not a secret (the caller typed it). 403 is fine here                                                                                                     |
|          L827 | `fils-pay/apps/api/src/routes/apiKeys.ts:35`                              | // MK: no, pending sessions can't reach this, requireSession checks authenticated. see auth/sessions.ts                                                                          |
|          L828 | `fils-pay/apps/api/src/onboarding/kycThumbnail.ts:30`                     | // YA: the 8 MiB upload cap protects us here                                                                                                                                     |
|          L829 | `fils-pay/apps/api/src/onboarding/kycThumbnail.ts:31`                     | // FH: sharp's default pixel limit is ~268MP, a tiny png can decode huge. copilot suggests limitInputPixels                                                                      |
|          L830 | `fils-pay/apps/api/src/onboarding/review.ts:33`                           | // YA: single-merchant review writes merchant_kyc_reviews. bulk should reuse this                                                                                                |
|          L831 | `fils-pay/apps/api/src/onboarding/review.ts:34`                           | // MK: bulk writes the review trail too (kyc_bulk_approve audit row)                                                                                                             |
|          L832 | `fils-pay/apps/api/src/routes/paymentLinks.ts:51`                         | // MK: it checks the path merchant, not that the link belongs to that merchant?                                                                                                  |
|          L833 | `fils-pay/apps/api/src/routes/analytics.ts:39`                            | // FH: Claude says this is off by one between 21:00 and 24:00 UTC                                                                                                                |
|          L834 | `fils-pay/apps/api/src/routes/analytics.ts:40`                            | // MK: that's exactly when Bahrain is already on the next day. it's correct                                                                                                      |
|          L835 | `fils-pay/apps/api/src/routes/analytics.ts:69`                            | // FH: from > to isn't rejected, you just get an empty list. fine?                                                                                                               |
|          L836 | `fils-pay/apps/api/src/routes/admin.ts:110`                               | // FH: audit row committed BEFORE the cross-process call, so a crash still leaves a trace. correct                                                                               |
|          L837 | `fils-pay/apps/api/src/routes/admin.ts:264`                               | // MK: recalculate_mdr.go selects paid batches too?? line ~70                                                                                                                    |
|          L838 | `fils-pay/apps/api/src/routes/admin.ts:328`                               | // YA: disabled admins' grants keep working until they expire — should end-all on disable? FP-238                                                                               |
|          L839 | `fils-pay/apps/api/src/routes/adminAuth.ts:179`                           | // YA: why is the cookie set twice (login and verify)? Claude says remove one                                                                                                    |
|          L840 | `fils-pay/apps/api/src/routes/adminAuth.ts:180`                           | // FH: the second one re-issues at the full session TTL. the merchant flow should do the same                                                                                    |
|          L841 | `fils-pay/apps/api/src/routes/adminAdjustmentImport.ts:57`                | // MK: finance checks the spreadsheet before uploading. fine for now                                                                                                             |
|          L842 | `fils-pay/apps/api/src/routes/adminAdjustmentImport.ts:58`                | // FH: parseAdjustmentCsv handles 3dp BD amounts correctly (4.750 -> 4750 fils), Claude checked                                                                                  |
|          L843 | `fils-pay/apps/api/src/routes/adminBalanceAdjustments.test.ts:183`        | // FH: Claude suggests auto-creating the row instead. no — MK                                                                                                                   |
|          L844 | `fils-pay/apps/api/src/routes/admin.test.ts:205`                          | // MK: does it? i only see signup -> login -> otp verify there                                                                                                                   |
|          L845 | `fils-pay/apps/api/src/routes/admin.test.ts:799`                          | // YA: there was never a grace period in the design. rotation = revoke                                                                                                           |
|          L846 | `fils-pay/apps/api/src/routes/adminAdjustmentImport.test.ts:237`          | // MK: BD has 3 decimals?? 4.75 BD is 4750 fils                                                                                                                                  |
|          L847 | `fils-pay/apps/api/src/reporting/transactionsReportQuery.test.ts:82`      | // FH: "named merchant" = the merchant in the filter. this is intended for the marketplace case (MK)                                                                             |

---

**Final disposition:** CTF cipher chain and flag: **verified**. Narrative events: **present in commit messages, not independently verified**. Code issues: **prioritized review leads pending source-level confirmation**. Preserve original evidence and distinguish assertions from measurements.
