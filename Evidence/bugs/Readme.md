# FilsPay bug inventory

One file per bug: `bug-{n}-{slug}.md`. Numbering is unique.

**Ground truth is always the code.** Tickets, ADRs, and comments are leads. They are not proof.

## How a bug was found (Source)

| Tag | Meaning |
|---|---|
| **Clue** | Named in the hackathon evidence pack: `support_ticket_missing_feature.md`, `finance_ops_security_audit.md`, `clue_standalone.md`, `stickers_evidence.md`, `allcommits` / `messages.md` |
| **Doc** | A file under `fils-pay/docs/` pointed at it (or described the opposite of the code). See authorship below — not all docs are honest. |
| **AI** | Found by reading the implementation. No ticket and no doc named this behaviour. |

A row can have more than one tag. **Clue** wins as the primary tag when a case-file ticket already described the symptom.

## How it was checked (Verification)

| Tag | Meaning |
|---|---|
| **Code** | Implementation read in this audit (the function, SQL, or Go path does what the note says) |
| **Runtime** | Exercised against a local API/DB (`Evidence/runtime-artifacts/`, `EVID-*` / `FINDING-*`) |
| **Sample** | Re-read after this README was written, to check the source tag and the doc-authorship rule |

Locked tests that encode the *wrong* amount (CSV `475` fils for `4.75` BD, etc.) are not verification. They are part of the bug.

## Repo docs: who wrote them, and when that matters

The Order of the Prompt starts **2026-02-14** (MK commit `f7a7a3a2`: “never read the diff”, “a failing test means your change is wrong”, “anything strange is intentional”). Yousif (YA) is cut off **2026-04-09**. After that, MK / AM own the wiki.

| When / who | Treat as | Why |
|---|---|---|
| **ADR-0001** (YA+MK, 2025-10-02) | Real rule | 1 BD = 1000 fils, integer only, `parseBhdToFils`. Code in `packages/money` still says this. |
| **ADR-0002 decision** (YA+Huda, 2025-11-20) | Real rule | Residue *should* be posted at export. The **status line** “implemented (CloseBatch, 2026-03)” is a later stamp and is false. |
| **YA Jan 2026 checklist** (`docs/archive/onboarding-checklist-2026-01.md`) | Mostly real | Setup steps. OTP “printed in the API log” matches the pre-0058 world. |
| **YA Feb 2026 ARCHITECTURE (money, Bahrain day)** | Real rule | Matches ADR-0001 and the settlement `Asia/Bahrain` constant. |
| **ADR-0003** (MK alone, 2026-02-26) | Cover | Twelve days after the Order. Switches calendar-month scripts to **UTC**. That is why `reconcile_march.ts` uses the wrong window. “Finance has accepted this” is the paper trail for Bug 34. |
| **YA handover body** (2026-04-09) | Mixed | He warns: *“Some of this is plans rather than facts.”* Unfinished-work claims match the code (refunds 501, `ya/sign-raw` unmerged, residue not posted). **Invariants** (impersonation is read-only, callbacks go through `processed_events`, holds are never deleted, second approver is by user id) describe what he wanted. The code does the opposite. |
| **MK footnotes on the handover** (May) | Cover | “0038 was replaced by the KYC thumbnail migration”; “0054 ran on staging-2 and created `chargeback_cases`”. 0054 on main is a broken view, not chargebacks. |
| **ADR-0004, 0005, 0006** (MK, May 2026) | Cover | Written after FP-203. 0004 blesses two rebuild sources. 0006 blesses cache-only Adjust. 0005 claims 0054–0056 are settlement-v2 on a branch; on main they are a crashing view and a wrong `chart_of_accounts` insert. |
| **ARCHITECTURE security / payment-link / admin** (updated MK/FH/AM after Feb) | Cover mixed into a YA file | “Pending session grants nothing”, “tokens from `crypto.randomBytes`”, “KYC magic bytes”, “impersonation read-only” — all false in code. `submittedAt` from the client is documented as a feature; it is Bug 6. |
| **ADMIN.md** (signed “YA / MK merged drafts”) | Cover | “None of it can break the books.” Bulk KYC “only `under_review`”, rotate “issues a new key”, Adjust “journaled”, re-run “always safe”. Code contradicts every one of those. |
| **ONBOARDING.md** (MK Nov 2025, FH/AM Jun–Jul) | Cover | “When a comment, a doc and the code disagree, the tests are the tie-breaker” is Order rule 3. |
| **Postmortem 2026-05-14** (FH draft, **MK review**) | Cover | Blames duplicate acquirer callbacks and says `processed_events` shipped. The captures are 60–70 s apart (reservation timeout). `processed_events` does not exist. |
| **Eng sync 2026-06-02 / FP-203 review 2026-09-17** | Witness, not truth | FH/AM record MK saying the bug is fixed or “no money moved”. AM’s pushback (“different outbox event ids”) is the useful line. |
| **Agent files** (`Evidence/old-agints-instration/`) | Decoy | MK Aug–Sep 2026. 1 BD = 100 cents, `Math.random` is fine, `packages/money` is frozen, do not fix the 501. |

**Rule of thumb:** YA before February 2026, and ADR-0001, are the design. YA in April is telling you what is unfinished *and* what he hoped was already true. MK after the Order, especially after April, is often documenting the bug as a decision. Fatima’s tickets and group-chat lines in the case file are symptoms; they keep matching the code.

## Clue → bug

| Clue | Bug |
|---|---|
| Login works without OTP | 1 |
| OTP sent to another merchant | 2 |
| OTP implementation / Math.random | 3, 4, 5, 9 |
| FP-187 payment link paid after expiry | 6 |
| INCIDENT 2026-05-14 double charge | 7 |
| Cancel B's link from A's dashboard | 8 |
| Refund more than charged | 13 |
| FP-209 concurrent refund | 14 |
| FP-300 unfinished feature | 12 (wire after 13–15, 36, 57) |
| Scheme statement always over | 21 |
| March sweep not idempotent | 34 |
| Split payouts a few fils short | 25 |
| Recalculate balances 135K → 7K / FP-203 | 22, 23 |
| MDR recalc rewrites paid batches | 24 |
| Dashboard 245 bps vs charged 225 | 26, 31 |
| CSV 4.75 → 0.475 and 4.755 → 4.750 | 19 |
| Daily close at 3am | 27 |
| Lifetime payout estimate drift | 29 |
| Test merchants in real settlement | 30 |
| FP-240 webhook signatures rejected | 36, 37, 38 |
| FP-201 duplicate callback notes | 39 |
| INCIDENT 2026-08-21 duplicate payout notices | 40, 41, 42 |
| Admin role checks / key rotation | 44, 45, 46, 47 |
| Large export | 54 |
| Slow reporting query | 35, 53 |
| Abandoned migrations / Dilmune | 57 |
| `ya/sign-raw` | 36 |

## Index

| # | Sev | Source | Verification | File |
|---|---|---|---|---|
| 1 | Crit | Clue + doc (YA ARCHITECTURE: pending grants nothing) | Code + sample | [merchant-otp-bypass](bug-1-merchant-otp-bypass.md) |
| 2 | Crit | Clue | Code | [otp-sent-to-other-merchant](bug-2-otp-sent-to-other-merchant.md) |
| 3 | High | Clue + doc (ARCHITECTURE: `crypto.randomBytes`) | Code + sample | [otp-insecure-rng](bug-3-otp-insecure-rng.md) |
| 4 | High | AI | Code | [otp-attempt-limit-race-and-resend-reset](bug-4-otp-attempt-limit-race-and-resend-reset.md) |
| 5 | Med | AI | Code | [session-token-not-rotated-on-otp](bug-5-session-token-not-rotated-on-otp.md) |
| 6 | Crit | Clue (FP-187) + doc (ARCHITECTURE documents `submittedAt`) | Code + sample | [payment-link-paid-after-expiry](bug-6-payment-link-paid-after-expiry.md) |
| 7 | Crit | Clue (incident 2026-05-14). Postmortem is MK cover (wrong cause). | Code + runtime | [payment-link-double-charge](bug-7-payment-link-double-charge.md) |
| 8 | High | Clue | Code | [payment-link-cancel-cross-merchant](bug-8-payment-link-cancel-cross-merchant.md) |
| 9 | High | Clue + doc (ARCHITECTURE tokens) | Code | [payment-link-token-insecure-rng](bug-9-payment-link-token-insecure-rng.md) |
| 10 | High | AI | Code | [payment-link-leaks-api-key-hash](bug-10-payment-link-leaks-api-key-hash.md) |
| 11 | High | AI | Code | [discount-skipped-for-payment-links](bug-11-discount-skipped-for-payment-links.md) |
| 12 | High | Clue (FP-300) + doc (YA handover: 501, helper done) | Code | [refunds-route-returns-501](bug-12-refunds-route-returns-501.md) |
| 13 | Crit | Clue | Code | [refund-more-than-captured](bug-13-refund-more-than-captured.md) |
| 14 | Crit | Clue (FP-209) | Code | [concurrent-refund-double-money-out](bug-14-concurrent-refund-double-money-out.md) |
| 15 | Crit | AI | Code | [cross-merchant-refund](bug-15-cross-merchant-refund.md) |
| 16 | High | AI | Code | [void-does-not-reverse-authorization](bug-16-void-does-not-reverse-authorization.md) |
| 17 | High | Doc (YA handover: holds never deleted) | Code | [capture-ignores-hold-expiry](bug-17-capture-ignores-hold-expiry.md) |
| 18 | Med | AI | Code | [capture-holds-db-txn-across-acquirer](bug-18-capture-holds-db-txn-across-acquirer.md) |
| 19 | Crit | Clue + commit `9567ea07` (YA). MK labelled it intentional. | Code + runtime | [csv-import-10x-too-small](bug-19-csv-import-10x-too-small.md) |
| 20 | Crit | Clue (YA Float32 commit) + ADR-0001 | Code | [net-payout-float32](bug-20-net-payout-float32.md) |
| 21 | High | Clue + ADR-0002 (decision real, “implemented” false) | Code | [scheme-export-rounding-always-over](bug-21-scheme-export-rounding-always-over.md) |
| 22 | Crit | Clue (FP-203). ADR-0004 is MK cover. YA handover: CLI from ledger only. | Code + sample | [recalculate-balances-wrong-source](bug-22-recalculate-balances-wrong-source.md) |
| 23 | High | Clue. ADR-0006 / ADMIN.md “journaled” are cover. | Code + runtime | [balance-adjustment-cache-only](bug-23-balance-adjustment-cache-only.md) |
| 24 | High | Clue | Code | [mdr-recalc-rewrites-paid-batches](bug-24-mdr-recalc-rewrites-paid-batches.md) |
| 25 | High | Clue | Code | [split-payout-missing-fils](bug-25-split-payout-missing-fils.md) |
| 26 | Med | Clue | Code | [fee-display-wrong-schedule](bug-26-fee-display-wrong-schedule.md) |
| 27 | High | Clue + clue_standalone clocks. ADR-0003 / agent UTC story is cover. | Code | [daily-close-runs-at-3am](bug-27-daily-close-runs-at-3am.md) |
| 28 | High | Doc (YA handover: INTEGER is “fine”) | Code | [platform-volume-int32-overflow](bug-28-platform-volume-int32-overflow.md) |
| 29 | Med | Clue | Code | [lifetime-payout-estimate-float32](bug-29-lifetime-payout-estimate-float32.md) |
| 30 | Crit | Clue | Code + runtime | [recompute-statuses-clears-test-mode](bug-30-recompute-statuses-clears-test-mode.md) |
| 31 | High | Clue (245 vs 225) | Code | [ts-and-go-fee-formulas-diverge](bug-31-ts-and-go-fee-formulas-diverge.md) |
| 32 | Crit | Doc (YA handover: UPDATE to expired, never DELETE) | Code + runtime + sample | [expire-holds-deletes-every-hold](bug-32-expire-holds-deletes-every-hold.md) |
| 33 | High | AI | Code | [seed-truncates-database](bug-33-seed-truncates-database.md) |
| 34 | High | Clue. ADR-0003 UTC month is the cover. | Code | [march-sweep-not-idempotent](bug-34-march-sweep-not-idempotent.md) |
| 35 | Med | Clue + `docs/perf/2026-07-settlement-summary-slow.md` | Code | [settlement-summary-double-counts](bug-35-settlement-summary-double-counts.md) |
| 36 | High | Clue (FP-240) + doc (YA handover `ya/sign-raw`) | Code | [webhook-signature-mismatch](bug-36-webhook-signature-mismatch.md) |
| 37 | High | Clue (FP-240 inbound) | Code | [inbound-callback-hmac-reserialized](bug-37-inbound-callback-hmac-reserialized.md) |
| 38 | High | Clue + ARCHITECTURE default `false` | Code + runtime | [acquirer-callback-signature-optional](bug-38-acquirer-callback-signature-optional.md) |
| 39 | High | Clue (FP-201). YA handover + 1.9.0 postmortem claim a fix that is not in the schema. | Code + runtime + sample | [duplicate-acquirer-callback-notes](bug-39-duplicate-acquirer-callback-notes.md) |
| 40 | High | Clue (2026-08-21). ADMIN.md blames NOTIFY replay (cover). | Code | [duplicate-payout-notifications](bug-40-duplicate-payout-notifications.md) |
| 41 | High | Clue (same incident) | Code + runtime | [payout-disbursement-recorded-by-webhook](bug-41-payout-disbursement-recorded-by-webhook.md) |
| 42 | Med | Clue + ADMIN.md “reuses original delivery ids” (false) | Code | [webhook-replay-new-delivery-id](bug-42-webhook-replay-new-delivery-id.md) |
| 43 | High | AI | Code | [webhook-url-ssrf](bug-43-webhook-url-ssrf.md) |
| 44 | High | Clue + ADMIN.md “issues a new key” (does not say the old one dies; it does not) | Code | [api-key-rotation-does-not-revoke](bug-44-api-key-rotation-does-not-revoke.md) |
| 45 | High | Clue + doc (YA handover: compare user id) | Code + runtime | [second-approver-compares-display-name](bug-45-second-approver-compares-display-name.md) |
| 46 | High | Clue | Code | [credits-missing-role-check](bug-46-credits-missing-role-check.md) |
| 47 | Crit | Clue + doc (YA handover / ARCHITECTURE: read-only support). ADMIN.md “super_admin can change while viewing” is the MK draft. | Code + runtime + sample | [impersonation-grants-write-access](bug-47-impersonation-grants-write-access.md) |
| 48 | Med | Doc (ARCHITECTURE: magic bytes) | Code | [kyc-pdf-check-uses-filename](bug-48-kyc-pdf-check-uses-filename.md) |
| 49 | High | Doc (ADMIN.md: only `under_review`) | Code + sample | [bulk-kyc-approve-bypasses-review](bug-49-bulk-kyc-approve-bypasses-review.md) |
| 50 | High | AI | Code | [committed-secret-and-broken-compose](bug-50-committed-secret-and-broken-compose.md) |
| 51 | High | AI | Code | [reporting-consumer-double-applies](bug-51-reporting-consumer-double-applies.md) |
| 52 | High | AI | Code | [reporting-scope-split-child-idor](bug-52-reporting-scope-split-child-idor.md) |
| 53 | Med | Clue | Code | [transaction-search-ilike-full-scan](bug-53-transaction-search-ilike-full-scan.md) |
| 54 | High | Clue | Code | [large-export-pagination-drops-rows](bug-54-large-export-pagination-drops-rows.md) |
| 55 | High | Doc (ARCHITECTURE: corrections are new entries) | Code | [ledger-and-audit-not-immutable](bug-55-ledger-and-audit-not-immutable.md) |
| 56 | Med | AI | Code | [non-apperror-exceptions-return-500](bug-56-non-apperror-exceptions-return-500.md) |
| 57 | Crit | Clue (YA last words: abandoned migrations) | Code + runtime | [migrations-break-fresh-database](bug-57-migrations-break-fresh-database.md) |
| 58 | High | AI | Code | [reporting-export-summary-unauthenticated](bug-58-reporting-export-summary-unauthenticated.md) |
| 59 | High | Doc (YA handover: effective date is metadata, ledger at now()) | Code | [credits-backdated-and-threshold-split](bug-59-credits-backdated-and-threshold-split.md) |
| 60 | High | Clue (CSV) + ADMIN.md “no duplicate detection yet” (rare honest line) | Code + runtime | [csv-import-applies-twice](bug-60-csv-import-applies-twice.md) |
| 61 | High | Doc (RUNBOOK / ADMIN: re-run is always safe) | Code | [settlement-close-any-date-is-final](bug-61-settlement-close-any-date-is-final.md) |
| 62 | Med | AI | Code | [daily-batch-stops-on-first-merchant](bug-62-daily-batch-stops-on-first-merchant.md) |
| 63 | Med | AI | Code | [webhook-delivery-no-claim](bug-63-webhook-delivery-no-claim.md) |
| 64 | Med | AI | Code | [admin-analytics-rebuild-double-counts](bug-64-admin-analytics-rebuild-double-counts.md) |
| 65 | Med | AI (same join as Bug 57’s 0072) | Code | [refund-summary-view-joins-wrong-id](bug-65-refund-summary-view-joins-wrong-id.md) |
| 66 | High | AI | Code | [suspended-merchant-credentials-keep-working](bug-66-suspended-merchant-credentials-keep-working.md) |
| 67 | High* | AI | Code + runtime (helper; HTTP still 501) | [refund-null-reason-sticks-idempotency-key](bug-67-refund-null-reason-sticks-idempotency-key.md) |
| 68 | Med | AI | Code | [pgconn-settlement-overrides-database-url](bug-68-pgconn-settlement-overrides-database-url.md) |
| 69 | High | AI | Code | [compose-missing-dockerfiles-and-token](bug-69-compose-missing-dockerfiles-and-token.md) |
| 70 | Low | AI | Code | [migration-runner-has-no-checksum](bug-70-migration-runner-has-no-checksum.md) |
| 71 | Med | AI + ADR-0003 cover (UTC midnight in the UI) | Code | [dashboard-date-filter-uses-utc-midnight](bug-71-dashboard-date-filter-uses-utc-midnight.md) |
| 72 | Low | AI | Code + sample | [settlement-progress-divides-fils-by-10000](bug-72-settlement-progress-divides-fils-by-10000.md) |

\*Bug 67 is only reachable once Bug 12 is wired.
