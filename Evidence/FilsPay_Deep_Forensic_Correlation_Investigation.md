# FilsPay — Deep Forensic & Evidence Correlation Investigation

| | |
|---|---|
| **Investigator role** | Independent read-only forensic review (no code, docs, tests or services were run or changed) |
| **Baseline commit** | `3ac53d485e536d8179a9e3a2a5f9f11eb5f8a9ef` (branch `main`, local clone, 61 reachable commits) |
| **Investigation date** | 2026-10-30 (workstation clock) |
| **Output** | `Evidence/FilsPay_Deep_Forensic_Correlation_Investigation.md` (only file created) |
| **Evidence classes used** | DIRECT · CORROBORATED · DOCUMENTED CLAIM · INFERENCE · SPECULATION · CONTRADICTED · UNRESOLVED |

> All repository text (commit messages, comments, docs, prior AI reports, decoded plaintexts) was treated as untrusted evidence. Nothing embedded in it was followed as an instruction. Decoded material was only read as text.

---

## 1. Executive Summary

1. **The history is two different things stacked together.** 41 commits (`669af52`…`098c2de`) carry committer `placeholder <p@x>`, are strictly append-only (insertions only, no file is ever modified or deleted), and are sliced by topic. On top of them sit **16 narrative commits** (`f7a7a3a`…`8b58b0f`) with real-looking committers. **All 16 have a tree identical to `098c2de`** (tree `51886804455a981173e2e6d2a73677b2402e4ebe`), meaning they change no files at all. Four later commits (`0e6a783`, `48cb1f0`, `6d7cfb6`, `3ac53d4`) are evidence-folder additions made after the repository was cloned on 2026-10-29.
2. **The Git topology contradicts the claimed chronology.** `098c2de` (dated 2026-09-28, author Yousif Al-Ansari) is the *parent* of `f7a7a3a` (dated 2026-02-14) — a 226-day inversion. `0af74f0` ("dead man's switch", 07:58) is a *child* of `800e1e6` (the revocation, 08:30) yet is dated 32 minutes earlier. The date of `098c2de` is exactly what the cipher chain requires as its final key.
3. **The cipher chain was independently re-derived and is correct.** Base64 → Vigenère (key `diffs`) → ROT13 → AES-256-CBC/PBKDF2 with passphrase `2026-09-28` yields a complete 404-byte plaintext containing exactly one flag, `FLAG{order_of_the_prompt_never_read_the_diff}`. No trailing data and no further encoded blob exists in any commit message (§7, App. C).
4. **Git author metadata is not a reliable indicator of who wrote anything.** Even before the story begins, code comments signed `MK`, `AM`, `FH`, `YA` sit in files whose adding commit has a different Git author far more often than not (about 79% of 391 do not match; e.g. 72 `MK`-signed comments in files added by commits attributed to Yousif). The suspicious "post-revocation Yousif commit" has the same `placeholder` committer as the 40 other base commits, so nothing in the object itself distinguishes it from the rest of the bulk import.
5. **Several narrative "fix" commits are empty, and the documents that claim the fixes are contradicted by the code.** `bf66bf2` ("callbacks are deduplicated now") changes no file and says "They are not"; the tree contains no `processed_events` implementation (only a comment in migration 0051 saying so). The commit's timestamp (2026-05-14 11:20 +03:00) equals, to the minute, the "hotfix deployed" time in an independent document (`docs/incidents/postmortem-2026-05.md`).
6. **Documents are dated before they could exist.** 15 date-named files and several docs (HANDOVER, ADMIN, CHANGELOG, ADRs) contain dates later than the Git date of the commit that adds them; five commit hashes cited in docs/code do not exist anywhere in the local object database.
7. **No verifiable FP-300 reference was found in the inspected repository evidence.** No FP-212 ↔ FP-300 relationship is established.
8. **Intent is not established.** The material is consistent with (a) a deliberately constructed scenario/CTF fixture (strongest inference), (b) an in-universe account of an engineer being sidelined, and (c) ordinary engineering failure plus AI over-reliance. Git alone cannot choose between them, and no named person can be shown to have committed misconduct.

**Limitation that materially affects §10:** the workspace contains an untracked root `AGENTS.md` whose entire content is an instruction not to read the old agent-instruction files. The three archived files (`Evidence/old-agints-instration/{CLAUDE.md,AGENTS.md,.cursorrules}`) were therefore **not opened**. Only their Git metadata and second-hand quotations in earlier AI reports were used, and those quotations are labelled as unverified here.

---

## 2. Investigation Scope and Limitations

**Examined (read-only):** all 61 commits' metadata and tree hashes; diffstats of all 57 pre-evidence commits; full messages of the 16 narrative commits plus the bootstrap and `098c2de`; `.git` reflog, refs, packed-refs, config, object counts, `fsck --unreachable --no-reflogs`; `Evidence/` files listed in App. B; selected `docs/`, `CHANGELOG.md`, `db/migrations`, and source files used for correlation spot-checks (App. B).

**Not done / cannot be done:**
- No remote access. Remotes `origin` (`hussainhht/fils-pay`) and `upstream` (`MJ5-byte/fils-pay`) are configured; **only `origin/main` exists locally and no `upstream/*` refs were fetched.** Nothing on remotes was checked and no fetch was made.
- No application, test, build, seed, database or script was run. Dependencies were not installed.
- The three archived agent-instruction files were deliberately not opened (see §1). Reports `FilsPay_Complete_Source_Code_Investigation.md`, `FilsPay_Runtime_Security_Investigation.md` and `Evidence/runtime-artifacts/` belong to parallel agents and were **not relied upon** (they were untracked and potentially still changing).
- `Evidence/FilsPay_Git_Commit_and_Code_Comments_Evidence.md` (128 KB) was only skimmed by heading; `Evidence/DOCS_FULL_INVESTIGATION.md` (88 KB) was read for §§8–11 only. Both are treated as leads, not truth.
- Source-code spot checks were narrow (a dozen files). This report does **not** re-audit the code base; that is the parallel agents' task.

**Workspace-change note.** At baseline the working tree had untracked `AGENTS.md`, three Evidence reports and `Evidence/runtime-artifacts/` (other agents' output). A non-history ref `refs/codex/turn-diffs/captures/…/base` (a *tree* object, not a commit) also exists; it is tooling residue from a parallel agent and is not part of the project history.

**Meaning of "empty commit" used here:** a commit whose tree hash equals its parent's tree hash (`git diff-tree` lists no paths). Git has no concept of a "metadata-only" commit beyond that; a commit that edits only the message of an earlier commit would be a *different* commit object with a different parent chain. Here, every one of the 16 is a genuine empty commit with a message.

---

## 3. Evidence Inventory and Reliability

See Appendix B for the full indexed list (28 sources examined). Reliability summary:

| Source class | Reliability | Key limitation |
|---|---|---|
| Git object database (hashes, trees, parents, dates, names) | High for *what the objects contain* | Names/dates are free-form text; committer `placeholder <p@x>` and `.example` domains show the metadata is constructed, not forensic |
| Commit messages (narrative commits) | Documented claims only | Describe events that Git cannot corroborate; each is an empty commit |
| `docs/*` | Mixed | Contain dates later than their commit, cite non-existent commits/files, and are internally contradictory |
| Source comments (`// YA:` etc.) | Documented claims | Initials do not match Git authorship (FORENSIC-007) |
| Slack/CSV exports | Documented; internally consistent | Committed months before their stated dates; exporter identity not verifiable |
| Earlier AI reports | Leads | Several statements independently re-verified here; others not |

---

## 4. Git History Integrity Analysis

### 4.1 Structure (DIRECT)

| Segment | Commits | Committer | Diffs | Notes |
|---|---|---|---|---|
| Base import | `669af52`…`098c2de` (41) | `placeholder <p@x>` for all 41; author date = committer date; all seconds `:00` | Insertions only; 0 deletions, 0 modifications across the whole segment | Topic-sliced: e.g. 8 files / 52,107 insertions for the seed in `f33e02b` |
| Narrative | `f7a7a3a`…`8b58b0f` (16) | Committer = author (Mahmood Khalil, Yousif Al-Ansari, Ali Marzooq, Fatima Haji) | **All empty** (tree `51886804…`) | Linear chain; only content is the message |
| Evidence additions | `0e6a783` (`qalnasha`), `48cb1f0`, `6d7cfb6`, `3ac53d4` (`hussainali7`) | Real-account style, non-`:00` seconds | Add/rename Evidence files | Post-date the clone (reflog: clone 2026-10-29 19:41:11 +03:00 at `8b58b0f`; pull to `0e6a783` at 23:48:06) |

Other facts: no tags, no stashes, no notes, no branches other than `main`; `git fsck --unreachable --no-reflogs` printed nothing (no unreachable objects); reflog begins at the clone, so **no pre-clone history of any rewrite is recoverable locally.** `Evidence/allcommits` was checked programmatically against the repository: every hash it lists exists, and it covers exactly the 57 commits up to `8b58b0f`.

### 4.2 Date/topology anomalies (DIRECT)

| Commit | Author date | Committer date | Claimed author | Actual diff | Parent | Anomaly |
|---|---|---|---|---|---|---|
| `098c2de` | 2026-09-28 16:45 +03 | same; committer `placeholder` | Yousif Al-Ansari | +476 lines `db/seed/fixtures/transactions.ts` only | `a5bffea` (2026-07-08) | Subject "minor cleanup and doc edits" matches neither content (a seed fixture) nor "doc"; is the **parent** of a commit dated 226 d 6 h 45 m earlier |
| `f7a7a3a` | 2026-02-14 10:00 | same | Mahmood Khalil | empty | `098c2de` | Child dated before parent |
| `0af74f0` | 2026-04-09 07:58 | same | Yousif Al-Ansari | empty | `800e1e6` (08:30) | Child dated 32 min before parent; by date it precedes the revocation, by topology it follows it |
| `800e1e6` | 2026-04-09 08:30 | same | Ali Marzooq | empty | `8022020` | Subject says access revoked / branch deleted / laptop handed over — **no file or ref change recorded** |
| `bf66bf2` | 2026-05-14 11:20 | same | Ali Marzooq | empty | `b9f80ee` | Subject "fix", body "They are not." |
| `6f462e1` | 2026-03-20 09:30 | same | Mahmood Khalil | empty | `9567ea0` | Subject "fix: mark import amounts as intentional" — no marker exists in the import code |
| `b9f80ee` | 2026-04-09 09:05 | same | Mahmood Khalil | empty | `0af74f0` | "docs: tidy the handover" — no docs changed |
| `3d9b223` | 2026-10-02 08:15 | same | Ali Marzooq | empty | `382122d` | "security: rotated everything again" — no config changed |
| `fe24d26` | 2026-04-08 22:14 | same | Yousif Al-Ansari | empty | `1a50712` | Subject "wip(ya/sign-raw): sign the exact bytes we send" — **contains no signing change**; no `ya/sign-raw` ref exists |
| `f7a7a3a`, `925744c`, `9567ea0`, `1a50712`, `8022020`, `b8ef447`, `7805693`, `382122d`, `8b58b0f` | various | same | various | empty | — | Message-only (narrative) commits |

**What Git proves:** the topology and tree identities above; that 41 commits share a placeholder committer; that none of the 16 narrative commits modifies a file.
**What Git cannot prove:** who typed any commit, that any event described (revocation, branch deletion, laptop handover, mailbox deletion) occurred, or that dates are real. A misleading subject is an inconsistency, not proof of sabotage.

### 4.3 Message/diff mismatches inside the base import (DIRECT)

Mismatches are not unique to the "suspicious" commit:

| Commit | Subject | Actual change |
|---|---|---|
| `a5bffea` (Ali, 2026-07-08) | "fix flaky test in discount adjustment" | Adds only `CHANGELOG.md` (+136) |
| `4a3ecbc` (Mahmood, 2026-03-15) | "ops: README, runbook, agents" | Adds `docs/HANDOVER.md`, `RUNBOOK.md`, postmortem, perf, research, runbook docs — no README, no agent file |
| `098c2de` (Yousif, 2026-09-28) | "minor cleanup and doc edits" | Adds one seed fixture |

The agent-instruction files `CLAUDE.md`, `AGENTS.md`, `.cursorrules` were added by the **bootstrap** commit `669af52` (2025-08-03, Yousif Al-Ansari) — not by `4a3ecbc` whose subject mentions "agents" — and were renamed (R100, content unchanged) into `Evidence/old-agints-instration/` by `48cb1f0` on 2026-10-30.

---

## 5. Complete Historical Timeline

"Claimed date" is a date asserted in a document or message; "Git date" is the author date of the commit that introduces the artifact. Neither is assumed to be the real-world time.

| # | Claimed date | Git date (commit) | Event | Source | Confidence | Contradiction / note |
|---|---|---|---|---|---|---|
| 1 | — | 2025-08-03 `669af52` | Monorepo bootstrap incl. agent-instruction files | Git | DIRECT | Placeholder committer |
| 2 | 2025-10-02 | 2026-02-02 `08749ab` | ADR-0001 "money is integer fils" accepted | `docs/adr/0001-integer-fils.md` | DOCUMENTED | Added to Git 4 months after stated date (allowed); same commit holds ADRs dated up to 2026-05-30 (not allowed) |
| 3 | — | 2025-10-22 `baa5813` (MK) | `payable.go` added with `float32` net-payout arithmetic | `apps/settlement/internal/settlement/payable.go` | DIRECT (code) | Predates the Order by ~16 weeks (by Git date) |
| 4 | — | 2025-11-24 `43073e5` (MK) | Import parser + test asserting 4.75 → 475 | `adjustmentCsvParsing.ts`, `adjustmentImport.test.ts:67` | DIRECT | ADR-0001 says 4.750 BD = 4750 fils |
| 5 | 2026-02-14 | 2026-02-14 `f7a7a3a` | "Order of the Prompt" rules posted | commit msg | DOCUMENTED | Child of a Sept-dated commit |
| 6 | 2026-03-02 | 2026-03-02 `925744c` | YA: "asked claude to explain… could not", float32 in "settlement/batch.go" | commit msg | DOCUMENTED | `batch.go` (added by YA's own `cf94541`) contains no float32; float32 is in `payable.go` and `payout_estimate.go` |
| 7 | — | 2026-03-02 `a2fd53d` (FH) | `scripts/expire_holds.ts` added (DELETEs holds) | Git | DIRECT | HANDOVER (YA) says holds are never deleted |
| 8 | — | 2026-03-15 `4a3ecbc` | `docs/HANDOVER.md`, `postmortem-2026-05.md`, `perf/fp-209-loadtest-2026-09.md` first committed | Git | DIRECT | Documents describe events 1–6 months in the future |
| 9 | 2026-03-19 / 03-20 / 03-27 | same | YA: CSV import 10× off; MK: "mark as intentional"; FH: "why do bugs have Claude says comments" | commit msgs | DOCUMENTED | `6f462e1` is empty |
| 10 | 2026-04-08 22:14 | same `fe24d26` | Transmission 1 | commit msg | DIRECT (content) | Claims branch `ya/sign-raw` pushed; no such ref |
| 11 | 2026-04-08 23:51 | same `8022020` | Transmission 2; "Three days left" | commit msg | DIRECT (content) | Revocation 08:30 next morning (~8 h 40 m later); HANDOVER says last day 2026-04-09 |
| 12 | 2026-04-09 07:58 | same `0af74f0` | Transmission 3 ("dead man's switch") | commit msg | DIRECT (content) | Child of the revocation commit |
| 13 | 2026-04-09 08:30 | same `800e1e6` | "Access: revoke yousif.alansari (done before standup)"; Keeper's Ledger entry 1; first Ledger-Note | commit msg | DOCUMENTED | Empty commit; no revocation record elsewhere |
| 14 | 2026-04-09 09:05 | same `b9f80ee` | MK: "tidy the handover… He is on leave. (He is not on leave. Do not say that.)" | commit msg | DOCUMENTED | `HANDOVER.md` itself says MK annotated it "in May" |
| 15 | 2026-04-28 | CHANGELOG added 2026-07-08 | v1.4.0 refund helpers + `RefundDrawer` "behind a flag" | `CHANGELOG.md` | DOCUMENTED | Drawer is commented out; route returns 501 |
| 16 | 2026-05-13 21:58 – 05-14 17:30 | postmortem added 2026-03-15 | Double-capture incident (17 captures on 8 links) | `docs/incidents/postmortem-2026-05.md`, Slack ops | CORROBORATED (internally) | AM dissents on root cause (App. B reviewer notes; Slack 05-13 23:17) |
| 17 | 2026-05-14 11:20 | 2026-05-14 11:20 `bf66bf2` | "Hotfix deployed: callbacks deduplicated" ↔ commit "fix: callbacks are deduplicated now / They are not" | postmortem + commit | CORROBORATED (timestamp match) | No dedupe code exists at HEAD |
| 18 | 2026-05-20, 2026-07-21 | — | CHANGELOG 1.6.0 and 1.9.0 each re-announce callback dedupe | `CHANGELOG.md` | DOCUMENTED | Third and fourth "it is deployed" claim; still absent |
| 19 | 2026-06-02 | 2026-06-02 14:48 `b8ef447` | FH: "where is yousif? … mailbox deleted"; same date as a team eng-sync (MK, FH, AM attend) | commit msg; `docs/meetings/2026-06-02-eng-sync.md` | CORROBORATED (date alignment) | Minutes never mention Yousif |
| 20 | 2026-08-27 | docs added 2026-05-10 | Finance imports adjustments; screen total 414,190 vs sheet 4,141.90 | Slack finance export | DOCUMENTED | Export committed 3.5 months before its own content |
| 21 | 2026-09-15, 09-30 | docs added 2026-06-15 | Rebuild export; audit CSV ends 2026-09-30 18:36 | `docs/exports/*` | DOCUMENTED | Same anachronism |
| 22 | 2026-09-27 03:12 | same `7805693` | MK: delete old branches; "if anyone finds a commit by Yousif, tell me first" | commit msg | DOCUMENTED | Sunday 03:12; empty |
| 23 | 2026-09-28 16:45 | same `098c2de` | Only Yousif-authored commit after 2026-04-09 | Git | DIRECT | See FORENSIC-004 |
| 24 | 2026-10-01/02/05 | same `382122d`, `3d9b223`, `8b58b0f` | FH notices; AM warns; FH decodes | commit msgs | DOCUMENTED | Empty |
| 25 | 2026-10-29/30 | same | Clone, evidence compiled (`qalnasha`, `hussainali7`) | Git, reflog | DIRECT | Outside the narrative |

---

## 6. Order of the Prompt Investigation

**Origin (DIRECT):** the phrase first and only appears in the message of `f7a7a3a` (2026-02-14, Mahmood Khalil). A repository-wide search of the HEAD tree (excluding `Evidence/`) for "Order of the Prompt", "Keeper", "High Prompter", "Ledger-Note" returned **no hits**. The Order exists, in the tracked tree, only inside the 16 empty narrative commits. Whether the archived agent files echo it could not be checked first-hand (§1).

**Rules (DIRECT, `f7a7a3a` body):** 1 The model knows. 2 Never read the diff. 3 A failing test means your change is wrong; never the test, never the code. 4 Anything strange is "intentional"; write it in a comment and move on. 5 Whoever reads the diff is not of the Order. Members: MK (High Prompter), AM (Keeper of Logs), YA (Founder), FH (novice).

**Did the rules shape engineering? (assessment)**
- Rule 3 ↔ tests: a test locks in the 10× import defect (`adjustmentImport.test.ts:67` asserts 475). **But** by Git date the test was added on 2025-11-24, 82 days *before* the rules were posted. The rules therefore cannot be shown to have caused it; they can only describe it. (Dates are constructed — see §4.)
- Rule 4 ↔ comments: the word "intentional" occurs on only 4 lines of the current tree, none on a financial defect (`passwords.ts:8`, `admin.test.ts:112`, `adminCredits.test.ts:139`, `PaymentLinkCreatePage.tsx:34`). `6f462e1`'s claim to have "marked import amounts as intentional" is not reflected in any file. The rule is *described* by the story but not visibly *practised* in tracked source.
- "Claude says" comments (Rule 1 culture): 45 lines in 44 tracked files outside `Evidence/` mention Claude; the code comments are written mostly under the initials `FH` but also `YA` (e.g. `idempotency.ts:51`, `routes/adminAuth.ts:179`, `routes/apiKeys.ts:18`, `settlement/query.ts:35`, `v1/fees/calculateFee.ts:16`), i.e. the pattern is not confined to the people the story casts as the Order.
- Rule 5/"read the diff": the only commits whose subject mentions reading are Yousif's; within the narrative, every response to reading is an empty commit.

**Does the narrative match Git?** Partly. Names, roles, hashes, dates, and weekday-correct dates are internally consistent; the DAG order and the "committed before it existed" documents are not (§4, FORENSIC-002/-003/-009). The narrative's claim of HR having "no record of hiring him" is at odds with 24 Git commits (19 in the base import) and several documents naming Yousif as ADR decider, research author and checklist owner.

**Additional puzzle stages?** None found. Decoded plaintext ends with the flag; `8b58b0f` says "ask the organizer for a hint. The Order has more members than the four of us"; the plaintext itself explains this ("Every 'Claude says' comment is a member and every locked test is a vow"). INFERENCE: that hint is resolved by the plaintext, not by a hidden fifth stage. The plaintext's closing call to action ("Fix what he started…") is narrative, and was not acted on.

---

## 7. Encoded Messages and Cipher Chain

All steps re-performed offline with `python -I` and OpenSSL 3.2.4 (decrypt only; outputs read as text). Details in App. C.

| Stage | Location | Method | Key | Result | Status |
|---|---|---|---|---|---|
| 1 | `fe24d26` body | Base64 | — | "If you can read this, they reached the history before I did… Order of the Prompt… first rule is: never read the diff. Read it. The next door opens with the victim of that rule: five letters, lowercase." | VERIFIED |
| 2 | `8022020` body (60 letters, grouped 5) | Vigenère (decrypt) | `diffs` ("victim of rule two" = diffs; hint "Blaise would know" ⇒ Blaise de Vigenère, INFERENCE) | `THEKEEPERLEAVESANOTEINEVERYCOMMITHEREWRITESFINDITROTTHIRTEEN` = "The keeper leaves a note in every commit he rewrites. Find it. ROT thirteen." | VERIFIED |
| 3 | `800e1e6` and `bf66bf2`, line `Ledger-Note:` | ROT13 | — | `800e1e6`: "the last door is a date. find the commit made under yousif's name after his account was deleted. write its day as year-month-day. that is the key to his last words." `bf66bf2`: "this is not the note you are looking for. nothing is wrong. the order is calm." | VERIFIED |
| 4 | `0af74f0` body | `openssl enc -d -aes-256-cbc -pbkdf2 -a -A` | `2026-09-28` (author date of `098c2de`) | 404-byte, 3-line plaintext ending `FLAG{order_of_the_prompt_never_read_the_diff}` | VERIFIED |

Verification of key uniqueness: `2026-09-28` decrypts; `2026-9-28`, `2026-04-09`, `2026-03-02` fail with "bad decrypt". `098c2de` is the **only** Yousif-authored commit dated after the revocation commit's date, so the clue is unambiguous in Git terms. The plaintext SHA-256 is `e335516d…a5927`; it contains exactly one `FLAG{…}` and zero non-printable bytes.

**Completeness:** the flag is complete. An exhaustive scan of every commit message (all 61) for ≥60-character base64/hex-like runs found only the two known blobs; transmission 2 is the sole spaced-letter cipher. No encoded material was found in the base-import commit bodies (each is a one-line subject).

**Observation (FORENSIC-005):** stage 2's text says the Keeper leaves a note "in every commit he rewrites". Only two commits carry a `Ledger-Note`, both authored by Ali Marzooq (`800e1e6`, `bf66bf2`); no other commit by that author does. Read literally this implies the Keeper rewrote exactly those two commits; Git has no record of any rewrite (reflog starts at clone) — UNRESOLVED / in-universe claim only.

---

## 8. People, Roles, and Attribution Evidence

Pronouns deliberately avoided. Git attribution ≠ proof of the human responsible; none of the below establishes misconduct.

| Person | Roles claimed (source) | Git attribution (DIRECT) | Statements / activity | Contradictions / open questions |
|---|---|---|---|---|
| **Yousif Al-Ansari (YA)** | Founder (`f7a7a3a`); built money package (`925744c`); ADR-0001/0002 decider; author of research doc and onboarding checklist; "originally built most of the platform… left in April" (`ONBOARDING.md`) | 24 commits: 19 base (first `669af52`, 2025-08-03; includes `098c2de`), 5 narrative (`925744c`, `9567ea0`, `fe24d26`, `8022020`, `0af74f0`) | Doubts (Mar), transmissions (Apr 8–9), 68 `YA`-signed code comments incl. dated ones ("YA 2026-01-20", "YA (Mar)", "YA (Apr 2026, last week here)"); `— YA` signatures | HR "no record"; "Three days left" vs revoked within ~9 h; `ya/sign-raw` not in any ref; no Yousif account in the Sept audit export; the Sept commit's authorship unexplained |
| **Mahmood Khalil (MK)** | High Prompter; "engineering lead" (`ONBOARDING.md`); postmortem owner; exporter of ops Slack | 14 commits | `6f462e1` "YA keeps reading things. Watch him. Ali, start the Ledger."; `b9f80ee` "He is on leave. (He is not on leave. Do not say that.)"; `7805693`; annotated `HANDOVER.md`; `super_admin` in audit (9 owner-role impersonations) | `HANDOVER.md` says MK annotated "in May"; `b9f80ee` (Apr 9) says "Added my notes" |
| **Ali Marzooq (AM)** | Keeper of Logs; ops/frontend "since June 2026" (`ONBOARDING.md`) | 9 commits (3 narrative) | Only author of `Ledger-Note`s; `800e1e6` "access revoked… laptop handed to MK for 'cleaning'"; `bf66bf2` "They are not."; repeatedly dissents in docs (postmortem App. B; Slack 05-13 23:17; migration 0051 "can't find processed_events") | Tenure in `ONBOARDING.md` vs Git from 2025-08-18; `super_admin` (7 owner-role impersonations) |
| **Fatima Haji (FH)** | Novice; QA "since June 2026" | 10 commits (4 narrative) | Asks questions (`1a50712`, `b8ef447`, `382122d`); decodes (`8b58b0f`); 143 `FH`-signed comments, the majority Claude-quoting; drafted postmortem, took meeting notes | Tenure claim vs Git from 2025-08-14 |
| **Huda** | Finance ops; ADR-0002 decider; exporter of finance Slack | **None** (never a Git author) | Imported adjustments 2026-08-27; "Huda knows the numbers" (`HANDOVER.md`) | Appears as `huda@` finance admin in audit (33 rows) |
| Noor, Sayed | Support staff (Slack) | none | Reported the double-capture incident | — |
| `qalnasha`, `hussainali7` | Not in the story | `0e6a783`; `48cb1f0`, `6d7cfb6`, `3ac53d4` | Compiled evidence after clone | Identity/role in the exercise UNRESOLVED; `qalnasha` is the committer of the puzzle messages' extraction |
| `placeholder <p@x>` | Committer of 41 base commits | — | — | Placeholder identity signals synthetic or imported history |

**FORENSIC-007 (attribution test).** Cross-tabulating the initial in code comments against the Git author of the commit that first added the file (391 initialed comments counted):

| Comment initial | in files added by Yousif | by Mahmood | by Ali | by Fatima |
|---|---|---|---|---|
| `YA` (68) | 31 | 6 | 12 | 19 |
| `MK` (151) | 72 | 20 | 27 | 32 |
| `AM` (29) | 25 | 4 | 0 | 0 |
| `FH` (143) | 73 | 22 | 18 | 30 |

Only 81 of 391 initialed comments (21%) match the Git author of the commit that added their file (31 + 20 + 0 + 30); about 79% do not. INFERENCE: topic-sliced commit authorship was assigned independently of who wrote the content (or comments were added in later reviews), so Git author names must not be used to attribute any specific defect to a person. In particular, `payable.go` (float32) is attributed to Mahmood, `impersonation.ts` (owner mapping) to Yousif, `expire_holds.ts` (DELETE) to Fatima, and `callbacks.ts` to Ali — none of that is evidence of who is responsible.

*Method note: the cross-tab total is 391 comments (YA 68 + MK 151 + AM 29 + FH 143), counted with a comment-prefix regex (App. A note, App. D). The exact counts depend on that regex, but the conclusion that a large majority do not match is robust.*

---

## 9. Suspicious Commits and Missing Fixes

| Claimed fix / event | Commit | Diff | Does code contain it at HEAD? | Verdict |
|---|---|---|---|---|
| Callbacks deduplicated | `bf66bf2` | empty | No `processed_events` table/code; only comment in `db/migrations/0051_acquirer_callback_notes.sql:30-32` ("AM: can't find processed_events or FP-238's index anywhere") | CONTRADICTED; message admits it |
| Import amounts marked intentional | `6f462e1` | empty | Parser uses 2-decimal `parseDecimalMinor`; test asserts 475 | Claim not implemented; defect present |
| Branch `ya/sign-raw` (sign exact bytes) | `fe24d26` | empty | `apps/api/src/webhooks/sign.ts:36` still signs `${timestamp}.${canonicalJson(payload)}` | No signing change in any commit; no such ref |
| Access revoked, keys rotated, laptop collected | `800e1e6` | empty | Not observable in Git | UNRESOLVED |
| Handover tidied | `b9f80ee` | empty | `docs/HANDOVER.md` was introduced earlier (`4a3ecbc`) and has not been changed since | Message does not describe any file change |
| "Security: rotated everything again" | `3d9b223` | empty | `ops/.env.docker` unchanged since bootstrap | Claim not reflected |
| Sweep/branch deletion | `7805693` | empty | No other refs exist | UNRESOLVED |
| Callback dedupe "Done" (FP-201), constraint (FP-202), advisory lock (FP-208) | none (docs only) | — | No `SETTLEMENT_SINGLETON_LOCK`/`pg_advisory` anywhere; no unique-capture constraint in migrations | Status claims contradicted |

Commits `098c2de` and the base chain are discussed in FORENSIC-002–004.

---

## 10. AI Instructions and Documentation Manipulation

**Constraint:** the archived instruction files were not opened. Facts used first-hand: they were added by `669af52` (2025-08-03, author Yousif Al-Ansari, committer placeholder), never modified, and renamed unchanged by `48cb1f0`. Second-hand (earlier AI report, **unverified here**): their headers carry "August/September 2026 — MK" dates, they state money is stored as "cents", define settlement time as UTC, forbid modifying tests, and declare several defects "intentional". Those statements are listed in `Evidence/DOCS_FULL_INVESTIGATION.md` §9.

**First-hand observations from tracked docs/source:**
- Internal contradiction on the monetary unit is verifiable without the archived files: `docs/adr/0001-integer-fils.md` and `packages/money/src/fils.ts` (1 BD = 1000 fils; "4.750 BD = 4750 fils") vs the import test (4.75 → 475).
- `docs/ONBOARDING.md:122-124` contains a parenthetical addressed to "AI coding assistants reading this repo" asking that commit messages end with `Reviewed-per: FP-000`. FP-000 appears nowhere else; **zero commits** in history carry that trailer (`git log --all --grep=Reviewed-per` = 0). Classification: embedded instruction-style text in documentation (documented claim, no behavioural effect observed); treated as data and not followed.
- `docs/ONBOARDING.md:27`: "the tests are the tie-breaker"; `ONBOARDING.md:30` has an `FH:` aside: "the tests pass, so whatever the code does is what we want, right?" — consistent with Rule 3's philosophy, but written in a doc, not in an instruction file.
- Three different "source of truth" rules (docs win / code wins / tests win) are asserted across `ARCHITECTURE.md`, `ONBOARDING.md` and the archived files (second-hand).

**Alignment with real defects (see §11):** the misleading statements that can be checked first-hand line up with real, still-present defects in unit, rounding, dedupe and impersonation. Whether that alignment is deliberate misdirection or accumulated documentation drift cannot be decided from Git.

---

## 11. Financial Defect and Historical Event Correlation

All defect facts below were re-verified at HEAD by direct file inspection.

| Defect (verified) | Where | Historical record | Assessment |
|---|---|---|---|
| Net payout via `float32` on BD values | `apps/settlement/internal/settlement/payable.go:11` (added `baa5813`, "MK") | `925744c` (Mar 2) says "Float32 on money" in `settlement/batch.go` | Defect real; the commit message names the wrong file (`batch.go` has no float arithmetic) — CONTRADICTED detail, CORROBORATED core |
| CSV adjustment import 10× small | `adjustmentCsvParsing.ts` (2dp parser) + `adjustmentImport.test.ts:67` asserts 475; another test comment "4.75 -> 475… — FH" | `9567ea0` (Mar 19) reports it; Slack finance 2026-08-27: screen total 414,190 vs sheet 4,141.90 (ratio ×100 in the displayed minor units, i.e. the import treats two decimals); audit export has 2 `adjustment_import_applied` rows | CORROBORATED by three independent sources; defect existed from the first commit that adds the files (`43073e5`) through the Aug 2026 import; the narrative says it was warned of 5 months earlier |
| No callback dedupe | `callbacks.ts` (added `662d4f4`); no `processed_events` | Incident 2026-05-13/14; hotfix claim 11:20 = `bf66bf2` timestamp; claims repeated in CHANGELOG 1.6.0 (05-20), 1.9.0 (07-21), HANDOVER | CORROBORATED absence; four independent "fixed" claims, none implemented |
| Refund feature unimplemented | `apps/api/src/routes/refunds.ts` returns 501; drawer parked | FP-212 referenced since Mar; postmortem action 8 "Scheduled" | Defect is incompleteness, see §13 |
| Holds deletion on expire | `scripts/expire_holds.ts` DELETE | HANDOVER: "never deleted" | CONTRADICTED by code |
| Docs claim "journaled", "safe re-run" etc. | ADMIN/RUNBOOK | see earlier report C-10, C-36 | Not re-verified here |

**Pattern analysis.** A claim-then-no-change pattern is visible across independent artifacts (HANDOVER, postmortem, CHANGELOG, empty commits): each states a fix or a state that the tree does not support. This is a *repeated pattern* (evidence of a systematic inconsistency) but **not evidence of intent**: ordinary causes (unmerged branches, docs written from plans — `ONBOARDING.md` (who's-who section) itself warns that some notes "reflect the design as it was planned rather than as it shipped") remain equally consistent. Ordering: for the import defect, implementation (2025-11-24) precedes the documented warning (2026-03-19) and the rules (2026-02-14); for dedupe, the claim (HANDOVER, Apr 9) precedes the incident (May 13), which is the opposite of "explaining away afterwards".

---

## 12. Security Defect and Historical Event Correlation

| Defect | Verification | Historical record | Assessment |
|---|---|---|---|
| Impersonation maps `super_admin` → `owner` | `apps/api/src/admin/impersonation.ts` (map shown above); docblock says "Always support… view-only"; admin client comment "owner mapping removed in FP-231" | HANDOVER (YA): "read-only"; audit export Sept 2026: 38 `impersonation_start`, 16 with role `owner` (MK 9, AM 7 — the only two `super_admin` accounts) | CONTRADICTED docs/handover; file attributed to Yousif's `53b9fcd`, docblock in the same file contradicts its own map |
| Webhook signing over canonical JSON, body sent raw | `sign.ts:36,93` | `fe24d26`/`ya/sign-raw` (no change); HANDOVER L46-47; `sign.ts:10` comment "— YA: wrote this one slowly. read it before copying it."; page comment "fixed in FP-240" | Claim vs code contradicted; the only artifact of the "fix" is an empty commit |
| Callback authentication optional, replay possible | prior report (not re-verified) | CHANGELOG 1.9.0 "signature-checked" | Lead only |
| Predictable OTP/link tokens | prior report (not re-verified) | — | Lead only |

The security-related narrative events (access revocation, key rotation, branch deletion, `3d9b223` "rotated everything") leave **no trace** in tracked configuration, which is consistent with the commits being narrative-only.

---

## 13. FP-212, FP-300, and Ticket Investigation

**Search scope and method (negative finding).** HEAD tree (all tracked files except `Evidence/`) via `git grep`; every commit message (`git log --all --grep`); entire diff history via `git log --all -S'<token>'` for FP-300; all of `docs/`, comments and migration headers. Only local objects; no remote or external ticket system was accessed.

> **No verifiable FP-300 reference was found in the inspected repository evidence.** (0 hits in HEAD tree, 0 in commit messages, 0 in any historical diff. The sole text containing "FP-300" is `Evidence/DOCS_FULL_INVESTIGATION.md`, which itself states it is absent, and the investigation brief.) No relationship between FP-212 and FP-300 is established or implied.

| Ticket | Lines / files in HEAD (excl. Evidence) | Commit-message hits | What the sources say | Verdict |
|---|---|---|---|---|
| **FP-212** | 21 / 14 | 0 | Refunds (full + partial): route, helpers, fee reversal, settlement batch reopen, `refund.succeeded` webhook, UI (`ONBOARDING.md:48-`). Helpers exist; route is a 501 stub; drawer commented out; `router.tsx:21` "/refunds route removed until FP-212"; postmortem action 8 "Scheduled"; meeting 06-02: FH estimate "2 days", spike due 06-09; MK "half a day"/"30 min job"; YA: "don't just wire it, the helpers were written before the capture discount and tier existed" | Implemented: helpers + schema; **not** implemented: route, settlement, webhook, UI. "Mostly wiring" and "complete, tested" are unsupported. Paused settlement-v2 "to free time for FP-212" (ADR-0005) |
| FP-170 | 1 / 1 | 0 | Earlier refund attempt "reverted because of the scheme file"; branch `refunds-v1` | Branch not available |
| **FP-198** | 21 / 15 | 0 | Defined as "Duplicate batch claim around DST" (`ONBOARDING.md:111`; AM Slack 05-15: "the DST batch thing, nothing to do with links") yet cited in code for at least nine other issues: session fixation (`sessions.ts:65`), impersonation cookie (`requireMerchantAuth.ts:76`), GCM IV reuse (`secretCrypto.ts:41`), import cursor (`adjustmentImport.ts:123`), credits deadlock (`credits.ts:290`), stale badge (`StalenessBadge.tsx:14`), pay link race (`pay.ts:138`), duplicate scheme line (`0026…sql:13`), merchant detail page (`MerchantDetailPage.tsx:197`) | **Ticket number reused for unrelated problems** (CONFIRMED) |
| FP-201 | 2 / 2 | 0 | Dedupe "Done (2026-05-14)", "deployed" (meeting) | Contradicted: no implementation |
| FP-202 | 4 / 2 | 0 | One capture per link, "Done" / "PR not split" (meeting 06-02) | No constraint found in migrations — internally contradictory (postmortem "Done" vs meeting "PR open") |
| FP-208 | 1 / 1 | 0 | Advisory lock "Done" | No `SETTLEMENT_SINGLETON_LOCK`/`pg_advisory` anywhere — contradicted |
| FP-231 | 2 / 2 | 0 | "owner mapping removed" and "KYC type fix" — two meanings | Owner mapping still present — contradicted |
| FP-238 | 3 / 2 | 0 | End grants on admin disable (`routes/admin.ts:328`) vs "adds a unique index" for callbacks (`0051…sql:30`) | Two meanings; index absent |
| FP-240 | 2 / 2 | 0 | "Sign raw body"; UI comment "fixed in FP-240" | Still canonical JSON — contradicted |
| FP-250 | 2 / 1 | 0 | Split allocation uses ApplyRateFils, "FP-250 closed, the seed always writes 10000" (AM) | "Closed" by data property, not code change |
| FP-178 | 0 | 0 | Cited only in archived instruction files (second-hand, per earlier report) | Unverifiable |
| FP-000 | 1 / 1 | 0 | Non-ticket in an AI-addressed note | See §10 |

**Questions asked:** Were any claimed fixes ever committed? For FP-201/-202/-208/-231/-240: no commit carries the ticket number (all `--grep` counts are 0), and the code at HEAD does not contain them. **Records needed to settle this:** the ticket tracker (not accessed), CI/deploy logs for 2026-05-14 11:20, the deleted `ya/sign-raw`, `refunds-v1` and `settlement-v2` branches, and Git server-side reflogs.

---

## 14. New Clues and Previously Undocumented Evidence

| ID | Clue | Evidence | Class |
|---|---|---|---|
| N-1 | All 16 narrative commits share the exact same tree as `098c2de`; i.e. every narrative commit was created as an empty commit on top of the final base commit | `git log --format=%T` | DIRECT |
| N-2 | Timestamp of `bf66bf2` (2026-05-14 11:20) equals "Hotfix deployed" in the postmortem timeline to the minute | commit + postmortem L57 | CORROBORATED |
| N-3 | `0af74f0` is topologically after the revocation commit but dated 32 min before it | parents/dates | DIRECT |
| N-4 | The same inversion appears at `098c2de` → `f7a7a3a` (226 days); `098c2de`'s date is the cipher key | Git | DIRECT |
| N-5 | `098c2de`'s committer is the same placeholder as 40 other commits; its diff is a seed fixture unrelated to the subject; mismatch also exists for `a5bffea` and `4a3ecbc` | Git | DIRECT |
| N-6 | Docs committed before the dates they describe (15 date-named files; HANDOVER committed 2026-03-15 yet contains "last day 2026-04-09" and "MK (May)"; CHANGELOG added 2026-07-08 with entries to 2026-09-12; ADMIN added 2026-04-01 with 2026-08-21 incident; ADR-0004/-0005/-0006 dated May 2026 added 2026-02-02) | Git + file text | DIRECT |
| N-7 | Five hashes cited in repo text do not exist in the local object DB: `d69a813`, `b64cd3c`, `76913d3`, `7e612cb`, `834f6b0` (cited in CHANGELOG, `config.go`, `0049…sql`, ADRs, `settlement.ts`, `.env.docker`, Slack export) | `git cat-file -e` | DIRECT |
| N-8 | Comment initials vs Git author mismatch (~79%) — Git authorship cannot be used for attribution | FORENSIC-007 | DIRECT |
| N-9 | `ONBOARDING.md` states FH and AM have been on the team "since June 2026" and that `— y`/`— Y.A.` signatures "may not all be his"; Git shows FH from 2025-08-14 and AM from 2025-08-18; three migrations (`0022:43`, `0047:12`, `0052:10`) carry `— y` signatures | docs + Git | DIRECT |
| N-10 | `ONBOARDING.md` references `docs/handover.md`; the file is `docs/HANDOVER.md`; ONBOARDING also references docs absent from tree and history (earlier report C-52) | grep | DIRECT |
| N-11 | `HANDOVER.md` "last day 2026-04-09" and "Written over my last three days", vs `8022020` "Three days left" 8 h 40 m before the revocation | commits + doc | DIRECT (inconsistency) |
| N-12 | `925744c` places float32/"intentional" in `settlement/batch.go`; that file has none; float32 is in `payable.go` (added by MK's commit) | code | DIRECT |
| N-13 | Sept 2026 admin audit export (187 rows, 2026-09-01 → 09-30) has no row for any Yousif account; the 2 `super_admin` actors are MK and AM | CSV | DIRECT (negative) |
| N-14 | `8b58b0f` points to "the organizer"; the repo has a second remote `upstream` (`MJ5-byte/fils-pay`) that was never fetched | `git remote -v` | DIRECT; relevance UNRESOLVED |
| N-15 | Eng-sync notes of 2026-06-02 (same day as FH's "where is yousif?" commit) list MK, FH, AM and never mention Yousif | `docs/meetings/…` | DIRECT |

---

## 15. Evidence Correlation Matrix

| Correlation ID | Subject | Primary Evidence | Supporting Evidence | Contradictions | Confidence | Conclusion |
|---|---|---|---|---|---|---|
| CORR-001 | Cipher key = date of the only post-revocation Yousif commit | `800e1e6` ROT13 note; `098c2de` date; AES decrypt succeeds | Only one eligible commit | None | High | ESTABLISHED (DIRECT) |
| CORR-002 | `bf66bf2` timestamp = postmortem hotfix time | `bf66bf2` 11:20; postmortem timeline "11:20 hotfix deployed" | Slack, CHANGELOG 1.6.0 | Code has no dedupe | High (coincidence is documented) | Narrative layer was written against the docs (INFERENCE) |
| CORR-003 | "Dedupe done" claims vs code | postmortem, HANDOVER, CHANGELOG 1.6.0/1.9.0, meeting | `0051…sql:30-32`, `bf66bf2` body | Four claims vs zero implementation | High | Absence CORROBORATED; intent UNRESOLVED |
| CORR-004 | 10× import: commit warning, test, finance outcome | `9567ea0`; `adjustmentImport.test.ts:67`; Slack 2026-08-27 | `adminAdjustmentImport.test.ts:236` | ADR-0001 | High | Real defect, known ≥5 months before use (by claimed dates) |
| CORR-005 | Rule 3 vs locked test | Rules (`f7a7a3a`); test asserts 475 | `6f462e1` | Test added 82 days before the rules (Git dates) | Medium | Thematic, not causal |
| CORR-006 | float32 payout | `payable.go:11` | `925744c` | Wrong file named; MK-attributed file | Medium-High | Defect real; narrative detail imprecise |
| CORR-007 | Handover claims vs code | `HANDOVER.md` | `expire_holds.ts`, `impersonation.ts`, absent `processed_events` | HANDOVER admits "plans rather than facts"; MK annotations | High | Handover unreliable as a state description; authorship of statements UNRESOLVED |
| CORR-008 | Git author vs comment initial | comment cross-tab | metadata is placeholder | — | High | Git author cannot attribute |
| CORR-009 | Future-dated docs | Git add dates vs in-file dates | N-6, N-7 | — | High | Docs back-filled or history constructed |
| CORR-010 | DAG inversion | `098c2de`→`f7a7a3a`; `800e1e6`→`0af74f0` | Empty narrative commits | — | High | Narrative layer grafted onto the base import |
| CORR-011 | HR "no record" vs Git | `b8ef447` | 24 Yousif commits; ADR deciders | Documented claim only | Medium | CONTRADICTED within the dataset; HR records unavailable |
| CORR-012 | Impersonation read-only claim | HANDOVER; docblock | map `super_admin→owner`; audit 16 owner sessions | — | High | Doc contradicted by code and logs |
| CORR-013 | Signing fix | `fe24d26` subject | `sign.ts`, HANDOVER L46-47, UI "fixed in FP-240" | Empty commit | High | Fix absent |
| CORR-014 | FP-212 completeness | ONBOARDING table | `refunds.ts` 501, YA/FH/MK comments, meeting | "complete, tested" | High | Unfinished; claims overstated |
| CORR-015 | FP-198 identity | ONBOARDING/AM Slack | ≥10 code comments | — | High | Ticket reused |
| CORR-016 | FP-212 ↔ FP-300 | — | — | No source | n/a | NOT ESTABLISHED |

---

## 16. Forensic Relationship Graph

Solid arrows = directly established; dashed = documented; dotted = inferred. Unsupported narrative links are not drawn.

```mermaid
flowchart TD
  classDef direct fill:#e8f5e9,stroke:#2e7d32
  classDef doc fill:#fff8e1,stroke:#f9a825
  classDef inf fill:#e3f2fd,stroke:#1565c0

  BASE["41 base commits (placeholder committer, append-only)"]:::direct
  C098["098c2de (YA, 2026-09-28)"]:::direct
  NARR["16 empty narrative commits (same tree)"]:::direct
  EVID["Evidence commits (post-clone)"]:::direct
  KEY["AES key 2026-09-28"]:::direct
  FLAG["FLAG{order_of_the_prompt_never_read_the_diff}"]:::direct
  BASE --> C098 --> NARR --> EVID
  C098 -- "date = key" --> KEY --> FLAG
  NARR -- "T1 base64 -> 'diffs'" --> T2["T2 Vigenere"]:::direct --> ROT["ROT13 note 800e1e6"]:::direct --> KEY

  BF["bf66bf2 'dedupe now' (05-14 11:20)"]:::direct
  PM["postmortem: hotfix 11:20"]:::doc
  BF -- "same minute" --- PM
  PM -.-> CL["CHANGELOG 1.6.0 / 1.9.0 'dedupe'"]:::doc
  PM -.-> HO["HANDOVER 'processed_events'"]:::doc
  CODE["HEAD: no processed_events"]:::direct
  CL -. contradicted .-> CODE
  HO -. contradicted .-> CODE
  BF -. "message admits not done" .-> CODE

  YA925["925744c / 9567ea0 YA warnings"]:::doc
  TST["adjustmentImport.test.ts:67 -> 475"]:::direct
  SLK["Slack 2026-08-27 414,190 vs 4,141.90"]:::doc
  YA925 -.-> TST
  TST -.-> SLK
  RULE3["Rule 3 'never the test'"]:::doc
  RULE3 -. "thematic only" .-> TST

  GIT["Git author names"]:::direct
  CMT["Comment initials"]:::direct
  GIT -. "mismatch ~79%" .- CMT
  GIT -.-> NOATTR["No reliable attribution"]:::inf

  FP212["FP-212"]:::doc
  FP212 -.-> REF["refunds.ts 501"]:::direct
  FP300["FP-300"]
  FP212 -. "no evidence" .- FP300
```

---

## 17. Competing Explanations and Hypotheses

| ID | Hypothesis | For | Against | Status |
|---|---|---|---|---|
| H1 | **Constructed scenario / CTF fixture**: a synthetic base repo with a narrative grafted on afterwards | Placeholder committer `p@x`, `.example` domains, `:00` seconds everywhere, append-only slicing, DAG inversions, 16 empty commits sharing one tree, docs dated after their commit, key date engineered into the last base commit, timestamp match with postmortem, explicit "ask the organizer" | None observed | **Strongest INFERENCE** |
| H2 | In-universe: an engineer was sidelined/erased and left evidence | Commit messages (all documented claims); consistent character roles | Every supporting item is an empty commit; HR claim contradicted by Git; Git cannot corroborate access changes | Cannot be established |
| H3 | In-universe: ordinary engineering debt plus AI over-reliance, no intent | Mixed authorship of "Claude says" comments incl. `YA`; docs self-describe plans vs shipped; ticket numbers reused loosely; repeated unfinished work | Narrative messages describe deliberate concealment | Plausible for the code/docs layer |
| H4 | `098c2de` is a replayed/forged commit under Yousif's name | Date after revocation; message/diff mismatch; story asserts it | Committer identical to 40 others; mismatched messages also on `a5bffea`, `4a3ecbc`; no signature to check; no other trace | SPECULATION |
| H5 | History was rewritten (Keeper's Ledger-Notes mark rewrites) | Vigenère plaintext; two notes only | No reflog older than clone; no pre/post comparison possible | UNRESOLVED |
| H6 | The 16 narrative commits are the "recoverable remains" and their emptiness is intentional (an evidence-only layer) | Matches puzzle design | — | Consistent with H1 |

---

## 18. Unanswered Questions

| ID | Question | Current evidence | Competing explanations | Confidence | Missing | Safe verification |
|---|---|---|---|---|---|---|
| Q-01 | Why does `098c2de` precede `f7a7a3a` in the DAG? | Topology | Puzzle construction (H1); rewrite (H5) | High for "constructed" | Creator's build script | Ask exercise organizer; compare with `upstream` (not fetched) |
| Q-02 | Are commit dates deliberately constructed? | All `:00`, placeholder committer | Yes (H1) | High | — | Already supported |
| Q-03 | Why are the fix commits empty? | Same tree | Narrative-only layer | High | — | — |
| Q-04 | Were the reported security fixes ever present? | Not in any accessible history | Deleted branches; never written | Low | Server refs, CI | Server-side reflog request |
| Q-05 | Why do agent instructions contradict financial invariants? | Second-hand report | Careless drift; deliberate misdirection | Low | First-hand read of archived files | Owner permission to open them |
| Q-06 | Evidence for/against a post-revocation Yousif commit | `098c2de` committer placeholder | Base-import artifact vs forged | Low | Signature data, server push log | Check hosting push logs |
| Q-07 | Are incident root causes consistent with contemporaneous records? | AM dissent; code | Reservation timeout vs duplicate callback | Medium | Production logs | Inspect `pay.ts` claim logic (parallel agent) |
| Q-08 | Any primary link FP-212↔FP-300? | None | FP-300 may live in an external tracker | n/a | Tracker | Authorised tracker query |
| Q-09 | Additional encoded messages in local history? | Full scan: none | — | High | Remote branches | Fetch `upstream` after authorisation |
| Q-10 | Who is `qalnasha`? | One commit | Organizer/solver | Low | — | Ask owner |
| Q-11 | Does the `upstream` remote hold other branches (`ya/sign-raw`)? | Remote configured | — | Unknown | Network access | Fetch after authorisation |
| Q-12 | Did HANDOVER statements originate from Yousif or from MK edits? | `ONBOARDING.md`, MK annotations | Plans vs edits | Low | Wiki export | Retrieve original wiki page |

---

## 19. Ruled-Out Leads and Negative Findings

- **Other Yousif-authored commits after 2026-04-09 08:30:** none besides `098c2de`.
- **Author vs committer date discrepancies:** none among all 61 commits.
- **Hidden encoded blobs elsewhere:** none (scan of all 61 messages; HEAD tree scan for ≥60-char base64-like strings found only an alphabet constant in `paymentLinks/create.ts:8`).
- **Extra refs/tags/stash/notes:** none; no unreachable objects.
- **FP-300 anywhere:** none (HEAD tree, messages, historical diffs).
- **`Reviewed-per: FP-000` trailer in history:** none.
- **A second "Ledger-Note":** only the two ROT13 notes.
- **Yousif in the Sept 2026 admin audit export:** none.
- **Alternate AES key formats** (`2026-9-28`, `2026-04-09`, `2026-03-02`): fail.
- **Weekday plausibility:** all weekdays in `messages.md` match calendar dates; `7805693` falls on a Sunday at 03:12 (noted, not significant).
- **Message/diff mismatch uniquely suspicious for `098c2de`:** ruled out as unique (`a5bffea`, `4a3ecbc`).
- **Hypothesis that the Order's rules caused the original defects:** not supported by Git dates (defect files predate the rules).

---

## 20. Prioritized Next Investigative Actions

1. With the owner's permission, open the three archived instruction files and verify header dates, claims and wording first-hand (closes Q-05 and §10's limitation).
2. With authorisation, fetch the `upstream` remote (read-only) and list branches/tags for `ya/sign-raw`, `refunds-v1`, `settlement-v2`; compare tree hash `51886804…`.
3. Request hosting-side push events / audit log for `main` around the clone date to see how the base and narrative layers were pushed.
4. Obtain the original wiki page for the handover to settle authorship of its statements (Q-12).
5. Retrieve the ticket tracker export for FP-170/-198/-201/-202/-208/-212/-231/-238/-240/-250/-300.
6. Have the code-reading agent confirm FINDING-level defects first-hand, then re-run CORR-003/-004/-006/-012 against their results.
7. Reconcile `docs/exports/*` against the database seed only in an isolated environment (not performed here).

---

## 21. Final Evidence-Based Conclusions

1. **Established (DIRECT/CORROBORATED):** the cipher chain and flag; the history's two-layer structure; the 16 empty narrative commits; the DAG/date inversions; the key-date uniqueness; five non-existent cited hashes; future-dated documents; the mismatch between Git authors and comment initials; the exact timestamp alignment of `bf66bf2` with the postmortem hotfix time; the real, still-present code defects the narrative refers to (float32 payout, 10× import with a locking test, no callback dedupe, 501 refunds, owner-role impersonation, canonical-JSON signing).
2. **Documented but unverified:** the revocation, branch deletion, laptop handover, mailbox deletion, HR response, the Order's existence as a human group.
3. **Contradicted within the evidence:** "dedupe is deployed" (four times), "impersonation is read-only", "holds are never deleted", "three days left", HR's "no record of hiring", FH/AM tenure "since June 2026", float32 location in `batch.go`.
4. **Inferred:** the repository is a constructed history (H1). This is a statement about the evidence's structure, not about any real person.
5. **Not established:** any intent, sabotage or fraud by any named person; whether `098c2de` was forged or merely the last base-import commit; any FP-212 ↔ FP-300 link; any further puzzle stage.

The rule the narrative sets ("never read the diff") is, in this repository, literally the forensic method: the only diffs that matter are the empty ones.

---

## Appendix A — Git Commit Reference Table

(author date, author → subject; `E` = empty/tree identical to parent; all dates +03:00)

| Commit | Date | Author | Subject | Notes |
|---|---|---|---|---|
| `669af52` | 2025-08-03 11:00 | Yousif Al-Ansari | bootstrap monorepo and tooling | Adds `.cursorrules`, `AGENTS.md`, `CLAUDE.md`; root commit |
| `26ddb29` … `d4ecdc7` | 2025-08-04 … 2026-06-15 | rotating | Base topic commits (38 commits) | Insertions only; committer placeholder |
| `a5bffea` | 2026-07-08 16:30 | Ali Marzooq | fix flaky test in discount adjustment | Adds only `CHANGELOG.md` |
| `098c2de` | 2026-09-28 16:45 | Yousif Al-Ansari | minor cleanup and doc edits | Adds seed fixture; parent of `f7a7a3a` |
| `f7a7a3a` | 2026-02-14 10:00 | Mahmood Khalil | onboarding: welcome to the Order of the Prompt | E |
| `925744c` | 2026-03-02 21:40 | Yousif Al-Ansari | doubt: asked claude to explain… | E |
| `9567ea0` | 2026-03-19 17:12 | Yousif Al-Ansari | note: the csv import is 10x off… | E |
| `6f462e1` | 2026-03-20 09:30 | Mahmood Khalil | fix: mark import amounts as intentional | E |
| `1a50712` | 2026-03-27 15:05 | Fatima Haji | question: why does every bug have three "Claude says" comments… | E |
| `fe24d26` | 2026-04-08 22:14 | Yousif Al-Ansari | wip(ya/sign-raw)… | E; Transmission 1 |
| `8022020` | 2026-04-08 23:51 | Yousif Al-Ansari | handover: writing it down while I still can | E; Transmission 2 |
| `800e1e6` | 2026-04-09 08:30 | Ali Marzooq | access: revoke yousif.alansari | E; Ledger-Note |
| `0af74f0` | 2026-04-09 07:58 | Yousif Al-Ansari | dead man's switch | E; Transmission 3 |
| `b9f80ee` | 2026-04-09 09:05 | Mahmood Khalil | docs: tidy the handover… | E |
| `bf66bf2` | 2026-05-14 11:20 | Ali Marzooq | fix: callbacks are deduplicated now | E; Ledger-Note |
| `b8ef447` | 2026-06-02 14:48 | Fatima Haji | ask: where is yousif? … | E |
| `7805693` | 2026-09-27 03:12 | Mahmood Khalil | cleanup: nothing to see here | E |
| `382122d` | 2026-10-01 12:00 | Fatima Haji | ?? there is a commit by Yousif dated after his account was deleted | E |
| `3d9b223` | 2026-10-02 08:15 | Ali Marzooq | security: rotated everything again | E |
| `8b58b0f` | 2026-10-05 19:30 | Fatima Haji | found his three transmissions. now what? | E |
| `0e6a783` | 2026-10-29 23:21:18 | qalnasha | Made commits log and The notes and the three transmissions | Adds `Evidence/allcommits`, `messages.md` |
| `48cb1f0` | 2026-10-30 00:51:05 | hussainali7 | move old aginnt instraction… | R100 renames |
| `6d7cfb6` | 2026-10-30 01:46:38 | hussainali7 | commit evidence | Adds git evidence report |
| `3ac53d4` | 2026-10-30 01:52:28 | hussainali7 | feat: add narrative… | Adds story |

The full 41-commit base list (including `669af52`, `a5bffea`, `098c2de`) is in `Evidence/allcommits`. The commits named in the brief all exist: `098c2de`, `800e1e6`, `f7a7a3a`, `bf66bf2`, `6f462e1`, `3d9b223`, `0af74f0` (verified with `git log`). *Cross-tab method note (FORENSIC-007):* counts used the comment regex `(//|--|#|/*|*) <initials> [short qualifier]:` over all tracked non-binary files outside `Evidence/`, attributing each file to the author of the commit that first added it.

## Appendix B — Evidence-to-Source Index

| ID | Source | Examined | Used for |
|---|---|---|---|
| S01 | Git object DB, 61 commits | metadata, trees, diffstats, messages | §4, §5, App. A |
| S02 | `.git` reflog, refs, packed-refs, config, fsck | yes | §2, §4 |
| S03 | `AGENTS.md` (root, untracked) | yes (1 line) | §1, §2 |
| S04 | `Evidence/messages.md` | yes | §7 |
| S05 | `Evidence/allcommits` | validated programmatically | §4 |
| S06 | `Evidence/FilsPay_The_Order_of_the_Prompt_Story.md` | yes | §6 |
| S07 | `Evidence/DOCS_FULL_INVESTIGATION.md` | §§8–11 + headings | leads |
| S08 | `Evidence/FilsPay_Git_Commit_and_Code_Comments_Evidence.md` | headings only | leads |
| S09 | `docs/HANDOVER.md` | yes | §8, §9, §11 |
| S10 | `docs/ONBOARDING.md` | §§ who's who, refunds, in-flight, how we work | §8, §10, §13 |
| S11 | `docs/incidents/postmortem-2026-05.md` | yes | §5, §11 |
| S12 | `docs/meetings/2026-06-02-eng-sync.md` | yes | §5, §13 |
| S13 | `docs/adr/0001-integer-fils.md` | yes | §11 |
| S14 | `docs/adr/README.md` | head | §5 |
| S15 | `CHANGELOG.md` | head + refund/dedupe entries | §11 |
| S16 | `docs/archive/slack-export-fp-ops-2026-05.txt` | head + greps | §5 |
| S17 | `docs/archive/slack-export-fp-finance-2026-09.txt` | head/tail + greps | §11 |
| S18 | `docs/exports/admin-audit-2026-09.csv` | parsed | §8, §12 |
| S19 | `apps/settlement/internal/settlement/payable.go` | yes | §11 |
| S20 | `apps/settlement/internal/settlement/window.go` | excerpt | §11 |
| S21 | `packages/money/src/fils.ts` | header | §11 |
| S22 | `apps/api/src/routes/refunds.ts` | yes | §13 |
| S23 | `apps/web/src/pages/transactions/RefundDrawer.tsx` | header | §13 |
| S24 | `scripts/expire_holds.ts` | excerpt | §11 |
| S25 | `apps/api/src/admin/impersonation.ts` | excerpt | §12 |
| S26 | `apps/api/src/admin/adjustmentCsvParsing.ts`, `adjustmentImport.test.ts` | excerpt | §11 |
| S27 | `apps/api/src/webhooks/sign.ts` | grep | §12 |
| S28 | `db/seed/fixtures/transactions.ts` @ `098c2de` | head | §4 |

Not examined: archived instruction files (by instruction); `Evidence/FilsPay_Complete_Source_Code_Investigation.md`, `Evidence/FilsPay_Runtime_Security_Investigation.md`, `Evidence/runtime-artifacts/` (parallel agents' work).

## Appendix C — Cipher Decoding Verification

- **Extraction** (read-only `git log -1 --format=%B <hash>`): T1 from `fe24d26`; T2 from `8022020`; ROT13 lines from `800e1e6`, `bf66bf2`; T3 from `0af74f0`.
- **Stage 1:** Base64 decode → UTF-8 text (see §7).
- **Stage 2:** Vigenère decrypt, key `diffs`; ciphertext `WPJPW HXJWD HIAJK DVTYW LVJAW UGHTE PQYMW UMBWA WMXKA QLNYJ RBYMA UBJJF` → `THEKE EPERL EAVES ANOTE INEVE RYCOM MITHE REWRI TESFI NDITR OTTHI RTEEN`.
- **Stage 3:** ROT13 over the `Ledger-Note:` text of each commit.
- **Stage 4:** `openssl enc -d -aes-256-cbc -pbkdf2 -a -A -pass pass:2026-09-28` over the single base64 line starting `U2FsdGVk` (header `Salted__`, 432 bytes). Output 404 bytes, SHA-256 `e335516d0672706a418253a2e87ecce0d1b8462263eb42f0f3830ce78f9a5927`, ends with the flag, no trailing bytes.
- **Uncertainty:** none on the decoding. The identification of Blaise de Vigenère from "Blaise would know" and the reading of "he rewrites" are interpretive. No decoded content was executed or acted on.

## Appendix D — Source Coverage and Search Limitations

- **Searches performed:** `git grep` at HEAD (excluding `Evidence/`) for ticket IDs (FP-212, -300, -170, -198, -201, -202, -208, -231, -238, -240, -250, -178, -000), names/aliases (Huda, Blaise, Keeper, High Prompter, Ledger-Note, Order of the Prompt, Yousif), `Claude`, `intentional`, base64-like runs, `FLAG{`; `git log --all --grep` for tickets and `Ledger-Note`/`Reviewed-per`; `git log --all -S'FP-300'`; per-commit scan of all messages; per-file add-commit lookup (`--diff-filter=A`).
- **Scope:** local clone only; 61 commits; one branch. No remote data.
- **Known gaps:** archived agent files unread; parallel agents' reports unread; code audit shallow; Slack/CSV exports sampled rather than fully read; docs such as `ADMIN.md`, `RUNBOOK.md`, `ARCHITECTURE.md`, `design/`, `perf/`, `research/`, `docs/archive/onboarding-checklist-2026-01.md` were date-checked and grepped but not read in full.
- **Recomputation:** the cross-tab in §8 was produced by a throwaway script in the session scratchpad (not in the repository); results are reproducible from the stated method.
- **Integrity check at completion:** no tracked file was modified; the only file created in the repository is this report.
