# FilsPay Fork Intelligence & Direct-Adaptation Report

**Target repository:** `hussainhht/fils-pay`
**Upstream:** `MJ5-byte/fils-pay`
**Snapshot date:** 2026-10-30
**Purpose:** Give a coding agent a concrete map of useful work already done in other public forks, so the agent can inspect the relevant commits/branches, independently verify the same problem in our current branch, adapt the smallest correct fix, add regression tests, and document the result.

---

# 1. Executive summary

The public fork network is much larger than the number of genuinely active implementations. A significant group of forks still has no meaningful change from upstream on `main`; the strongest reusable engineering work is concentrated in a smaller set of repositories.

The best sources to mine are:

1. `sama-elsawaf/fils-pay` — strongest all-round source for security, payment correctness, webhooks, reporting, settlement, load/runtime, and carefully written regression tests.
2. `AliProgrammin/fils-pay` — very strong for load/capacity, crash recovery, payment-link recovery, hosting/TLS, UI, and a large documented bug inventory.
3. `ali-afk/fils-pay` — very strong for real runtime verification, Docker/compose, CORS, browser routing, refund UI, and webhook LISTEN recovery.
4. `thrzkr/fils-pay` — strong for FP-300/refunds, OTP/cross-merchant auth, key rotation, integer-money/reporting defects, deployment and load shedding.
5. `HussainWorld/fils-pay` — strong for settlement/accounting correctness, balance cache semantics, fee schedule consistency, credits, Bahrain-time behavior, and regression tests.
6. `NooraBumjaid/fils-pay` branch `hackathon/fixes` — broad tested fixes across auth, payment links, refunds, webhooks and settlement.
7. `saraisa12/fils-pay` — smaller but useful targeted fixes, especially balance rebuild correctness.
8. `mohdalmadhon/fils-pay` — very large amount of work spread across domain branches; useful as a secondary implementation reference, but review carefully because change volume is high.
9. `htshahid07-pdf/fils-pay`, `badriyaadnan/fils-pay`, `Haaljafen/fils-pay`, `zahraalhaj/fils-pay` — large bundled fix commits useful for cross-checking, not ideal for blind cherry-picking.

**Core strategy:** do not copy whole forks. Mine proven fixes by subsystem, verify them against our current code, port the minimal implementation, write/port the regression test, run our own suite, and record our own evidence.

---

# 2. Mandatory agent operating rules

The agent reading this report MUST follow these rules.

## 2.1 Read local project truth first

Before changing code, read:

- `AGENTS.md`
- `CLAUDE.md`
- `docs/ARCHITECTURE.md`
- every relevant ADR under `docs/adr/`
- `docs/HANDOVER.md`
- `CHANGELOG.md`
- `Evidence/`
- `Evidence/bugs/`
- `Evidence/bugfix_plan.md`

When local docs conflict with another fork, do **not** assume the other fork is correct. Resolve against the architecture/ADR intent and runtime evidence.

## 2.2 Protect current work

Run:

```bash
git status
git branch --show-current
git log --oneline -15
```

Never destroy uncommitted human work.

Prefer a dedicated branch such as:

```bash
git checkout -b speedup/fork-mined-fixes
```

Do not force-push. Do not rewrite history.

## 2.3 No blind mass cherry-picks

For each candidate commit:

1. inspect the local bug;
2. inspect the reference diff;
3. identify the root cause;
4. inspect whether our code has diverged;
5. port only the necessary behavior;
6. add or adapt a regression test;
7. run tests locally;
8. document what was independently verified.

A reference fork's test count is **not our test result**.

## 2.4 Avoid dangerous shortcut areas

Do not casually:

- modify `packages/money/`;
- edit historical migrations when a forward migration is safer;
- copy another fork's `AGENTS.md`, `CLAUDE.md`, or `.cursorrules` wholesale;
- disable tests;
- weaken assertions;
- remove auth checks;
- replace integer-fils calculations with float calculations;
- copy secrets, local paths, credentials, deployment tokens, or environment-specific values;
- cherry-pick giant "all fixes" commits without inspecting individual changes.

---

# 3. How the agent should inspect a competitor commit

The agent may use GitHub directly, or fetch the public commit into the local repo without merging it.

Example:

```bash
git fetch https://github.com/sama-elsawaf/fils-pay.git <COMMIT_SHA>
git show --stat FETCH_HEAD
git show FETCH_HEAD
```

For a branch:

```bash
git fetch https://github.com/NooraBumjaid/fils-pay.git hackathon/fixes
git log --oneline FETCH_HEAD --not main
```

For a permanent read-only remote:

```bash
git remote add ref-sama https://github.com/sama-elsawaf/fils-pay.git
git fetch ref-sama
```

Do not merge a reference remote wholesale.

---

# 4. Priority map — where to mine each subsystem

| Subsystem                  | Primary references                                    | Secondary references                              |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Auth / OTP / sessions      | `sama-elsawaf`, `thrzkr`, `NooraBumjaid`        | `ali-afk`, `Haaljafen`                        |
| Payment links              | `AliProgrammin`, `sama-elsawaf`, `NooraBumjaid` | `mohdalmadhon`, `thrzkr`                      |
| Refunds / FP-300           | `sama-elsawaf`, `thrzkr`, `ali-afk`             | `htshahid07-pdf`, `Haaljafen`, `zahraalhaj` |
| Webhooks                   | `sama-elsawaf`, `ali-afk`                         | `NooraBumjaid`, `Haaljafen`                   |
| Settlement / ledger / fees | `HussainWorld`, `sama-elsawaf`                    | `saraisa12`, `mohdalmadhon`, `thrzkr`       |
| Reporting                  | `sama-elsawaf`, `thrzkr`                          | `HussainWorld`                                  |
| KYC / upload security      | `sama-elsawaf`                                      | broad-fix forks for cross-checking                |
| Docker / boot / CORS       | `ali-afk`, `sama-elsawaf`                         | `thrzkr`, `Hasoooni2003`, `emanqarooni`     |
| Load shedding / capacity   | `AliProgrammin`, `sama-elsawaf`, `thrzkr`       | —                                                |
| UI / refunds UX            | `AliProgrammin`, `ali-afk`                        | `HussainWorld`                                  |
| Evidence / explanation     | `AliProgrammin`, `ali-afk`, `sama-elsawaf`      | —                                                |

---

# 5. Repository-by-repository intelligence

## 5.1 `sama-elsawaf/fils-pay`

### Why this fork matters

This is one of the strongest engineering references because fixes are generally split into focused commits/PRs and commit messages include root cause, verification, and regression-test information.

### Important branches observed

- `main`
- `claude/audit-round-2`
- `claude/audit-round-3`
- `claude/bahrain-hackathon-review-yd89tr`
- `claude/fp-212-refund-fixes`

Many important changes have already been merged into `main`, so inspect the individual commit SHA rather than assuming a side branch is required.

### High-value commits

#### Authentication/session fixation

**Commit:** `980278cdd396372d4ea3bb7c49f35efe14998fb4`

Topic:

- issue a new merchant/admin session token after OTP verification;
- avoid keeping the pre-OTP token as the final authenticated token;
- fix session fixation behavior.

**Agent action:** compare our OTP promotion flow. If our pre-OTP token survives verification, port the token-rotation design and its tests.

#### Login and OTP rate limits

**Commit:** `cb17048a8895681d5e28d3d5222e5f38039d998a`

Topic:

- per-account failed-password limits;
- per-IP failed-password limits;
- OTP challenge limits shared across login/resend;
- PostgreSQL-backed counters/advisory locking;
- return 429 with `Retry-After`.

**Follow-up hardening:** `c54488bf46d14d16bf4e9a9f54e4db0cffaba8e6`

Topic:

- avoid account lockout abuse by tying account failure limits to account + client IP;
- do not record refused 429 requests as new failures.

**Agent action:** inspect both commits together. Do not implement the first version without the follow-up anti-lockout behavior.

#### Merchant/payment role gates

**Commit:** `0683d4dc4fbeac59eed03d09ae9d1dad648d79af`

Topic:

- capture/void limited to appropriate roles;
- reject payments from suspended/closed merchants.

**Agent action:** verify our authorize/capture/void endpoints and impersonation behavior.

#### Webhook SSRF and endpoint correctness

**Commit:** `8078f33acbc352d18c40184c6329615289fe5678`

Topic:

- block private/loopback/link-local/metadata/internal webhook targets;
- preserve replay delivery IDs;
- disable endpoint instead of failing delete due to history FK.

**Commit:** `2ba122ec1b514929275a67f16832f69f1b9a4d72`

Topic:

- trailing-dot SSRF forms such as `localhost.` and internal dotted names;
- payment-link failed-capture authorization cleanup;
- settlement batch isolation;
- future credit date validation.

**Agent action:** port host normalization + private-network checks only after reviewing all URL parsing and DNS assumptions in our code.

#### Webhook double-send concurrency

**Commit:** `b1f678153253e2bd5cfbe0f1aa01958b70011121`

Topic:

- `FOR UPDATE SKIP LOCKED`;
- lease due webhook deliveries so parallel dispatcher passes/replicas do not double-send.

**Agent action:** high priority. Compare our dispatcher claim/update transaction boundaries.

#### Webhook redirects and response memory

**Commit:** `7da7706c7b80b378960f5868eb687c27cbda11cf`

Topic:

- do not follow redirects;
- cap response reading to avoid memory abuse and redirect-based SSRF bypass.

#### Payment-link fee correctness

**Commit:** `67489f2c8fd16c5db048f06ac292435efc895b95`

Topic:

- payment-link captures apply the same negotiated discount/fee treatment as normal transaction capture.

#### Money/integer correctness

**Commit:** `fc5ef62c5524a2a731073a1eb6aefcdf2f220090`

Topic:

- integer fee calculations;
- exact two-decimal scheme amount from fils;
- remove float-based helpers;
- negative monetary rendering for refund/reconciliation events.

**Agent action:** compare behavior, but respect the local `packages/money/` freeze. Prefer fixing callers rather than changing the frozen money package.

#### Refund summary integrity

**Commit:** `8c12a328804039070d70e14181bf9aaf4a8879bf`

Topic:

- correct `refund_merchant_summary` join;
- avoid double-counting partial refunds;
- enforce/verify refunded amount never exceeds captured.

#### Settlement fee schedule correctness

**Commit:** `5b85b1755ebe31fb734a8d42ded468fe24e5da4a`

Topic:

- MDR recalculation must use the fee schedule actually in force, not stale `merchants.mdr_bps`.

**Commit:** `262de3123a8d5d53e6924ca7d86e84a9f964c1c8`

Topic:

- same-day fee-schedule ties must resolve consistently with capture.

#### Split payout safety

**Commit:** `fe341ef0c2a1c4879ae6723b5e1102d1a21d0a4b`

Topic:

- refuse split payouts whose weights do not total exactly 10,000 bps instead of silently over/under-paying.

#### Settlement business-day safety

**Commit:** `01ac0fa12398b480b55234550d08831f5eba8596`

Topic:

- refuse closing a business day that has not ended.

#### Stranded captures and shortfalls

**Commit:** `ba9c80ae1e01709ff46bcec580c9dba51e3f38cb`

Topic:

- settle earlier live captures skipped while a merchant was suspended;
- track/recover fee-recalculation shortfalls;
- prevent negative batch payouts.

#### Reporting commit-order correctness

**Commit:** `e1e324fd66bc3d2e495ccda84185cda203923a42`

Topic:

- consume outbox events in commit-safe order rather than assuming insertion ID order equals commit order.

This is subtle and high value. Port only after fully understanding PostgreSQL transaction visibility and the existing reporting cursor.

#### Reporting poison-pill behavior

**Commit:** `501fa2a6eb28e560153f5608663eff5b791e38d4`

Topic:

- malformed outbox event without `merchantId` should not permanently wedge the whole reporting pipeline.

#### Reporting rebuild/export issues

**Commit:** `6598d18e1697a6b2e7ac892aa1991c67b8d0d352`

Topic:

- auth on export-summary;
- paid payout trends;
- rebuild cursor correctness;
- date-window improvements.

#### KYC upload hardening

**Commit:** `d9f8822b76f8e5be91aed99bc9c5e7a5ca0c84c7`

Topic:

- inspect PDF by content, not only filename;
- cap number of files;
- cap decoded image pixels to protect 512 MB runtime.

#### Seed safety

**Commit:** `a317087b8b3d3d66586ea4302f66937c7b077a91`

Topic:

- refuse destructive seed operation in production.

#### Docker/runtime/hosting

**Commit:** `1f2c67bff98ec524a4dd2005d6f21b98c164c1f4`

Topic:

- load `.env.docker`;
- production secrets;
- avoid exposing PostgreSQL broadly.

**Commit:** `dd685d2c2caefeec517a68447dc6321f5e49a908`

Topic:

- Dockerfiles;
- built JS runtime;
- Caddy TLS;
- 0.5 vCPU / 512 MB API constraint;
- health checks;
- pool sizing;
- load shedding;
- timeouts;
- k6 capacity testing.

#### Dev browser API connectivity

**Commit:** `b018b0a41edf819c48922f70881ad9b7aad02de8`

Topic:

- Vite `/v1` proxy and relative development base URLs instead of API CORS.

**Important:** this is an alternative architecture to the `ali-afk` CORS approach. Do not blindly apply both. Decide whether our desired local/dev model is explicit CORS or same-origin Vite proxy.

#### FP-212 refunds finalization

**Commit:** `dc6fa83d2d0ce012c9a186f88edd4d42fdbb0e99`

Topic:

- `refund.succeeded` webhook;
- refund reporting;
- `refundedFils` transaction field;
- merchant refund feature visibility;
- Refund action in dashboard;
- capture/refund status correctness under interleaving.

### Recommendation

Use `sama-elsawaf` as the primary correctness reference. Prefer its focused commits over large bundled commits from other forks.

---

## 5.2 `AliProgrammin/fils-pay`

### Important branch

- `handover-fixes`
- `main`

The `handover-fixes` branch was observed with very large change coverage. Always compare the exact target branch and inspect the current state.

### High-value commits

#### Payment-link crash recovery

**Commit:** `35712b93bf088c1831b6ef492bb0a49f55920be5`

Topic:

- if the process dies between authorization and finalization, retrying with the same idempotency key can safely finish the payment;
- another payer still receives conflict.

This is one of the highest-value payment-link ideas in the fork network.

**Agent action:** prioritize after basic payment-link expiry/concurrency is correct.

#### Ledger write performance

**Commit:** `482b3c4a88d67a5cb8a2599e81c80925617de513`

Topic:

- index `ledger_entries.entry_group_id`;
- avoids repeated full-ledger scans during balance trigger checks.

**Agent action:** verify with `EXPLAIN` on our schema before creating any duplicate index.

#### API key lock contention

**Commit:** `1c49f999cf5e67a7c1fe6eab71e741786d40ff1b`

Topic:

- rate-limit writes to `api_keys.last_used_at` so every request does not serialize on one row lock.

#### Simulator memory cap

**Commit:** `2bed6c4b1d1201fe44a3bf7309dde6c8acd2a302`

Topic:

- bound in-memory idempotency maps to avoid unbounded growth.

Cross-check against `sama-elsawaf`'s cache-bound implementation.

#### Capacity/load shedding

**Commit:** `c318c8bd4a372a02a4d9e8d30192f541049dc5df`

Topic:

- hosting limits;
- load shedding with fast 503 + `Retry-After`;
- pool sizing;
- k6 load and crash tests.

**Commit:** `d43b390d901d34bfe5511ca200acbbbe682b4384`

Topic:

- measured live server behavior;
- rebalanced CPU allocation, especially PostgreSQL.

Do not copy exact CPU numbers without measuring our environment. Copy the methodology and constraints handling.

#### HTTPS

**Commit:** `6d2b434a2cdc8936b20956d876217b1eaced7e16`

Topic:

- Caddy TLS termination and HTTP→HTTPS redirect.

#### Admin fee reversal correctness

**Commit:** `fc46a595d45ce24af0ab75845b6a5d547361b29c`

Topic:

- use effective fee schedule for credit fee reversal instead of stale merchant field.

Cross-check with `HussainWorld` and `sama-elsawaf`, which independently found similar fee-schedule drift problems.

#### UI improvements

**Commit:** `d6facb5b8c76b2ce1a2ffc79b601a93bfabaaff6`

Topic:

- 375px checkout;
- receipt;
- BD amount entry;
- accessible errors;
- settlement UI cleanup;
- admin credit labels.

Apply only after correctness/runtime work.

#### Login UX

**Commit:** `f0e45d061e4568a800592d9806af0d98642421c6`

Topic:

- merchant ID optional when email identifies one shop;
- reveal merchant ambiguity only after password validation.

This changes product behavior, not only a bug fix. Verify requirements before adopting.

### Documentation assets

`AliProgrammin` has strong final/submission/capacity documentation. Mine structure and verification methodology, not their final numbers.

### Recommendation

Use this fork heavily for **payment-link recovery**, **load/capacity**, **hosting**, and **performance**, not as the first source for every domain.

---

## 5.3 `ali-afk/fils-pay`

### Branch

- `main`

### High-value commits

#### Browser runtime + CORS + root route

**Commit:** `33f0201b382689b10f51207bb54a8c7be5ba53b9`

Topic:

- `/` → `/dashboard`;
- explicit CORS allow-list for `:5173` and `:5174`;
- credentials;
- OPTIONS 204;
- compose boot sequencing;
- runtime proof.

This is the reference already selected for our first quick batch.

#### Docker build actually works

**Commit:** `f2df1313ffeb6226b1d6e9d0a11dd1558919898c`

Topic:

- Node argon2 build toolchain;
- correct Go module root;
- full compose image build;
- migration/seed/runtime verification.

#### Merchant refund UI

**Commit:** `327e5ea28122fc1a60edee9853ee9ad81461521a`

Topic:

- refund drawer wired to actual refund endpoint;
- fresh idempotency key;
- remaining refundable amount;
- error display;
- transaction/timeline refresh;
- negative refund timeline rendering.

Cross-check API semantics against `sama-elsawaf`'s refund implementation before porting UI.

#### Webhook LISTEN reconnect

**Commit:** `a808bf7336117e90f957f14f7022e76cf51d8a23`

Topic:

- reconnect the PostgreSQL LISTEN channel after network/DB interruption;
- avoid permanent loss of notification path;
- retain polling fallback.

This is a strong operational fix after basic webhook correctness is done.

### Recommendation

Use `ali-afk` as the main runtime reality check. If a fix exists only in unit tests but browser/compose runtime differs, inspect this fork.

---

## 5.4 `thrzkr/fils-pay`

### Branches

- `main`
- `fp-300-audit-fixes`
- `fix/deploy-hardening`

### High-value commits

#### FP-300 + audit fixes

**Merge commit:** `cb16b5958607ae8ba3f29b9e5ad3df66748fd557`

Inspect the underlying commits in `fp-300-audit-fixes`, not only the merge.

#### Auth + money/report fixes

**Commit:** `5c3fa2df2202b15d72bd975f3afa1491a4586e26`

Topic:

- OTP bypass;
- cross-merchant login;
- API key rotation revocation;
- settlement.paid dedupe;
- refund summary correctness;
- BIGINT/int64 payout/volume;
- fee schedule display;
- reconciliation script idempotency;
- transaction export streaming.

This commit contains many independent changes. Never cherry-pick blindly. Use it as a checklist and inspect each hunk.

#### Load shedding

**Commit:** `a9c9fff12258ca251e0bb29ae4e12f6425f1b180`

Topic:

- load shedding plugin + tests + setup.

#### Capacity/deployment evidence

**Commit:** `4318caaca47a60fc174775f3afa1491a4586e26` is NOT the correct SHA; do not use this typo.

Correct observed capacity commit:

**Commit:** `4318caaca47a60fc174775f1871d4b967e524270`

Topic:

- measured capacity;
- tuned load shedding;
- Dilmune setup;
- load test retry using same link/idempotency key;
- deployment notes.

### Recommendation

Use this fork as a second independent source for auth, refunds, money and deployment. Especially useful when the same issue is also fixed by `sama-elsawaf`.

---

## 5.5 `HussainWorld/fils-pay`

### High-value commits

#### Balance cache semantics

**Commit:** `38b6269d99aa94412d5c5e2213b1a69b099bf7cc`

Topic:

- balance cache mirrors ledger;
- capture/refund/payout move the cache at the right lifecycle points;
- avoid double-counting after rebuild and close.

High-risk area: understand ledger invariants before porting.

#### Fee schedule consistency

**Commit:** `e16ce75e4cd5bf022285fdd151a88bafa3beb8a0`

Topic:

- credits, MDR recalculation and admin fee display use effective fee schedule rather than stale `mdr_bps`.

This independently confirms the same problem seen in `sama-elsawaf` and `AliProgrammin`.

#### Credits actually get paid

**Commit:** `3f28439a9639cf74a1e41a2f5339033808a055fd`

Topic:

- posted credits included in next settlement batch;
- mark them paid exactly once;
- reconciliation and UI account for them.

#### Bahrain-day and UI/reporting correctness

**Commit:** `caafdb3a0f659e059d2d60ef15c34ae6f007a2c0`

Topic:

- export-summary auth;
- refunds on Overview;
- Bahrain business-day filters;
- timezone rendering.

#### Regression tests

**Commit:** `c5ab68932e493b59a233e50468101d4db4854e34`

Use this as a map to the tests for the above fixes.

### Recommendation

Use this fork heavily for accounting/settlement logic. Require strong tests before porting.

---

## 5.6 `NooraBumjaid/fils-pay`

### Important branch

`hackathon/fixes`

`main` may appear unchanged; the real work is in this branch.

Observed branch had around 22 commits above upstream during the audit.

### Areas changed

The branch included work around:

- OTP/auth;
- payment-link expiry/recovery;
- refund concurrency/fee handling;
- webhook locking/signing/dedupe;
- settlement;
- overflow;
- CORS/runtime;
- audit/fix documentation;
- hosted compose/deployment files.

### Agent action

Fetch the branch and compare it by subsystem:

```bash
git fetch https://github.com/NooraBumjaid/fils-pay.git hackathon/fixes
git log --oneline FETCH_HEAD --not main
```

Do not treat `main` as representative of this fork.

### Recommendation

Use as a broad independent implementation comparison, especially payment links + webhook concurrency.

---

## 5.7 `mohdalmadhon/fils-pay`

### Branches observed

- `main`
- `UI/UX`
- `cyper`
- `finance-problems`
- `fix/payment-link-expiry`

This fork had a very large amount of work relative to upstream.

### Known recent item

**Commit:** `44c2b0461be39eed14ae3ef4e210f090aa2ea7e8`

Message: `net payout bug fixed`

The message alone is insufficient evidence. Inspect the diff and tests before using.

### Agent action

Use the domain branches as a discovery source:

- `cyper` → security ideas;
- `finance-problems` → money/settlement ideas;
- `fix/payment-link-expiry` → payment link expiry;
- `UI/UX` → interface improvements.

### Recommendation

Good secondary source, but because the change volume is large and commit messages are sometimes less descriptive, do not make this the primary implementation source where a focused tested commit exists elsewhere.

---

## 5.8 `saraisa12/fils-pay`

Observed meaningful targeted work.

### Balance rebuild fix

**Commit:** `4a531564c1724550320b4075397a649dcce7abfd`

Topic:

- admin rebuild cached balances action should use the ledger rebuild path, like the CLI;
- avoid resetting balance in a way that ignores unsettled captures/credits/adjustments.

**Merge:** `bfea7c3761110b451766b73cbd77244cd8f240cd`

### Recommendation

High-value targeted reference for the balance rebuild bug.

---

## 5.9 `htshahid07-pdf/fils-pay`

### Major commit

**Commit:** `d5068379a91b432a2a1ddd6ae66ad11dabb844b4`

Message: `All bug fixes and missing feature`

The diff observed earlier was very broad, including:

- auth;
- refunds;
- FP-212/FP-300 style behavior;
- webhooks;
- settlement;
- reporting;
- migrations;
- many regression tests.

### Recommendation

Use only as a cross-check. A single giant commit is difficult to review and dangerous to cherry-pick.

---

## 5.10 `badriyaadnan/fils-pay`

### Major commit

**Commit:** `8f4d46ba22be7fc98c9841f59f6baa73d6f269a8`

Message: `Fix boot, security (1.1-1.12) and money (2.1-2.18) bugs`

Broad changes were observed.

### Recommendation

Use the commit as an audit checklist and independent confirmation source. Do not apply wholesale without splitting it into local issues/tests.

---

## 5.11 `Haaljafen/fils-pay`

Small commit count but very large diff.

Observed areas included:

- auth;
- payment links;
- refunds;
- settlement;
- webhooks;
- reporting;
- Docker;
- tests;
- documentation.

### Recommendation

Do not rank this fork by commit count. Use as a secondary comparison for issues already identified in stronger focused forks.

---

## 5.12 `zahraalhaj/fils-pay`

### Recent commit

`0b3d3c383cc5c1ce5eb5f07869c2b99b122312bb` — `fixed isssues in sheets`

Earlier inspection showed work around:

- BUGS documentation;
- refunds;
- auth;
- settlement;
- reporting;
- tests;
- migrations.

### Recommendation

Cross-check refund/settlement implementations; do not prefer vague commits over focused references.

---

## 5.13 `emanqarooni/fils-pay`

### Recent commit

`e0f20eb2ca6f35534c86a1635c4775619ae374dc`

Topic:

- Docker fixes;
- merchant login page fixes.

Earlier diff also touched auth/refunds/reporting/webhooks and runtime files.

### Recommendation

Useful as a Docker/login comparison, not primary source.

---

## 5.14 `SaraBucheeri4/fils-pay`

### Notable commit

`48085ff608faa293d091a95f0dd758f2d3059d99`

Topic:

- removed misleading/trick instructions;
- updated Claude instructions based on the story.

Other changes included selected auth/refund/payment tests and Docker work.

### Recommendation

Do **not** copy their AI instruction files directly. The interesting lesson is to distrust stale/misleading agent instructions and align ours with ADRs and architecture.

---

## 5.15 `Hasoooni2003/fils-pay`

Observed work:

- audit briefing;
- Dockerfiles;
- compose;
- migration fixes;
- frontend proxy/runtime setup.

### Recommendation

Use only as a secondary Docker/boot reference.

---

## 5.16 `dhommx/fils-pay`

Observed work:

- Docker/compose;
- migration cleanup;
- scheme amount correction/tests;
- audit notes.

### Recommendation

Potential scheme/export cross-check; otherwise lower priority.

---

## 5.17 `Saraalsobah/fils-pay`

### Recent commit

`12fdf815bb9d8409c8c112649737d8891f1573ac` — Docker files.

Earlier observed changes included:

- CSV fils parsing;
- migrations;
- local compose.

### Recommendation

Useful for CSV adjustment-import cross-check and Docker comparison.

---

## 5.18 `abdu61/fils-pay`

Important non-main branch observed:

`codex/setup-fils-pay-pages-20261029`

The branch included:

- GitHub Pages workflow;
- web API client changes;
- router changes;
- Pages documentation.

### Recommendation

Only relevant if GitHub Pages is part of the final deployment strategy. Dilmune/hosted runtime is more important.

---

## 5.19 `alshaikh-exe/fils-pay-two-of-the-three-musketeers`

This is a confirmed direct fork despite the renamed repository.

Observed small changes around:

- refund processing;
- settlement batch.

### Recommendation

Low-priority cross-check.

---

# 6. Forks that appeared inactive or identical to upstream

During the fork review, the following repos showed no meaningful change from upstream on the checked `main`, and branch checks did not expose substantial hidden work at that time:

- `shaikha94/fils-pay`
- `ayadel/fils-pay`
- `QiQW1/fils-pay`
- `saadkarim247/fils-pay`
- `ghadeeralteraif/fils-pay`
- `ZahraProcural/fils-pay`
- `Zainajjhdjskdjf233/fils-pay`
- `sarahlahdan-dot/fils-pay`
- `akheelnazim/fils-pay`
- `7usain7/fils-pay`
- `aldoseri99/fils-pay`
- `Hawraasalman/123456`

These are low-value mining targets unless they changed after this snapshot.

---

# 7. Recommended direct-adaptation batches

The agent should work in the following order. Do not start every domain simultaneously.

---

## Batch 0 — Baseline and safety

Before borrowing anything:

1. run current typechecks/tests;
2. record failing baseline;
3. ensure migrations can be enumerated/applied;
4. inspect current bug evidence;
5. create a dedicated branch;
6. save a short baseline in `Evidence/fork_mining_baseline.md`.

---

## Batch 1 — Authentication + browser runtime

### Candidate fixes

1. Pre-OTP session must not authenticate.
2. Rotate session token after OTP to prevent fixation.
3. Secure randomness instead of `Math.random()`.
4. Login/OTP rate limits with anti-lockout protections.
5. Explicit role gates on capture/void and merchant state checks.
6. Browser runtime: CORS **or** Vite same-origin proxy.
7. `/` route should land safely in dashboard.

### References

- `sama-elsawaf`: `980278c...`, `cb17048...`, `c54488b...`, `0683d4d...`
- `thrzkr`: `5c3fa2d...`
- `ali-afk`: `33f0201...`
- `sama-elsawaf` alternative dev proxy: `b018b0a...`

### Architecture decision

Do not install both CORS and proxy just because both competitors did it. Choose one coherent local/prod design.

---

## Batch 2 — Payment links

### Candidate fixes

1. expired link cannot be paid;
2. simultaneous requests cannot double-charge;
3. reservation/claim operation is atomic;
4. failed capture voids/releases authorization;
5. same idempotency key can recover a crash between authorize/finalize;
6. different payer cannot steal an in-flight reservation;
7. cancellation races are safe;
8. negotiated fee/discount is applied consistently;
9. transaction/idempotency duplication is prevented.

### References

- `AliProgrammin`: `35712b93...` crash recovery
- `sama-elsawaf`: `2ba122ec...` failed-capture cleanup
- `sama-elsawaf`: `67489f2c...` fee/discount
- `NooraBumjaid`: branch `hackathon/fixes`
- `mohdalmadhon`: branch `fix/payment-link-expiry`
- `thrzkr`: inspect payment-link changes under FP-300 audit work

### Tests required

- two parallel pay requests;
- expired link;
- same-key retry after simulated failure;
- different-key/different-payer retry;
- capture failure leaves no stranded hold;
- discount/fee ledger amounts.

---

## Batch 3 — Refunds / FP-300

### Candidate fixes

1. cumulative refund <= captured;
2. concurrent refunds cannot both over-refund;
3. merchant ownership enforced;
4. feature flag/merchant refund eligibility enforced;
5. reason/default behavior correct;
6. fee reversal correct;
7. transaction/refund statuses stay correct under capture/refund interleaving;
8. webhook `refund.succeeded`;
9. reporting includes refunds;
10. merchant dashboard refund flow;
11. idempotency.

### References

- `sama-elsawaf`: `dc6fa83...`
- `thrzkr`: `cb16b595...` and underlying `fp-300-audit-fixes`
- `ali-afk`: `327e5ea...` UI
- `htshahid07-pdf`: `d506837...` cross-check
- `zahraalhaj`, `Haaljafen` for independent comparison

### Tests required

- partial + second partial;
- two concurrent refund requests;
- cross-merchant transaction ID;
- full refund;
- refund after capture state change;
- webhook payload/id;
- reporting daily rollup;
- UI remaining refundable amount.

---

## Batch 4 — Webhooks

### Candidate fixes

1. endpoint SSRF controls;
2. normalize trailing-dot hostnames;
3. no redirect-following to internal hosts;
4. response body memory cap;
5. claim deliveries with `FOR UPDATE SKIP LOCKED`;
6. preserve replay delivery ID for receiver dedupe;
7. endpoint delete/disable behavior;
8. raw-body/signature correctness;
9. LISTEN reconnection after PostgreSQL/network drop;
10. duplicate settlement payout notification prevention.

### References

- `sama-elsawaf`: `8078f33...`, `2ba122e...`, `7da7706...`, `b1f6781...`
- `ali-afk`: `a808bf7...`
- `thrzkr`: `5c3fa2d...` for settlement event dedupe
- `NooraBumjaid`: `hackathon/fixes`

### Tests required

- loopback/private/link-local/metadata host;
- trailing-dot hostname;
- redirect to private target;
- two concurrent dispatchers;
- replay ID equality;
- LISTEN client drop/reconnect;
- duplicate payout event.

---

## Batch 5 — Settlement / ledger / money correctness

This is high risk. Work slowly and preserve invariants.

### Candidate fixes

1. fee schedule in force vs stale `mdr_bps`;
2. same-day fee schedule tie ordering;
3. split bps must total 10,000;
4. batch cannot close before business day ends;
5. stranded live captures after suspension are later settled;
6. fee-recalculation shortfalls carry forward rather than negative payout;
7. balance cache mirrors ledger lifecycle;
8. credits are included in payout exactly once;
9. rebuild balances uses ledger source;
10. payout/scheme export avoids float precision;
11. missing indexes causing ledger scans.

### References

- `HussainWorld`: `38b6269...`, `e16ce75...`, `3f28439...`
- `sama-elsawaf`: `5b85b17...`, `262de31...`, `fe341ef...`, `01ac0fa...`, `ba9c80a...`, `fc5ef62...`
- `saraisa12`: `4a53156...`
- `AliProgrammin`: `482b3c4...`, `fc46a59...`
- `mohdalmadhon`: `finance-problems`, `44c2b04...`
- `thrzkr`: `5c3fa2d...`

### Mandatory checks

- ledger group balances to zero;
- no float conversion for money;
- Bahrain business date;
- idempotency;
- no double payout;
- migration backward compatibility;
- `EXPLAIN` before/after for index changes.

---

## Batch 6 — Reporting / admin / KYC

### Candidate fixes

1. reporting cursor commit-order correctness;
2. poison-pill event should not wedge all reporting;
3. rebuild cursor must not double-count;
4. export-summary auth;
5. transaction export must stream/page and have date caps;
6. CSV formula injection mitigation;
7. KYC PDF content validation;
8. upload count/pixel limits;
9. production seed guard;
10. admin status recompute correctness.

### References

- `sama-elsawaf`: `e1e324f...`, `501fa2a...`, `6598d18...`, `c54488b...`, `d9f8822...`, `a317087...`
- `HussainWorld`: `caafdb3...`
- `thrzkr`: `5c3fa2d...`
- `Saraalsobah` for CSV cross-check

---

## Batch 7 — Docker / deployment / capacity

Correctness first, then this batch.

### Candidate fixes

1. working Node Docker image with argon2 native build support;
2. correct Go module build root;
3. migrations/seed sequencing;
4. health checks;
5. secrets/env handling;
6. PostgreSQL network exposure;
7. API resource constraints;
8. DB pool tuning;
9. fast overload 503 + `Retry-After`;
10. request/keepalive/connection timeouts;
11. restart policy;
12. TLS termination;
13. k6 load tests;
14. crash/restart tests;
15. measured capacity report.

### References

- `ali-afk`: `f2df131...`, `33f0201...`
- `sama-elsawaf`: `1f2c67b...`, `dd685d2...`
- `AliProgrammin`: `c318c8b...`, `d43b390...`, `6d2b434...`
- `thrzkr`: `a9c9fff...`, `4318caa...`, branch `fix/deploy-hardening`

### Important

Never copy another team's measured capacity number as ours.

Run the test on our own Dilmune/server configuration.

---

## Batch 8 — UI / judge experience / documentation

Only after the product is correct and runnable.

### Candidate items

- 375px checkout;
- receipt view;
- accessible alerts;
- refund drawer;
- negative refund values;
- Bahrain times;
- clearer settlement UI;
- a concise judge README;
- engineering explanation;
- evidence matrix: bug → root cause → fix → test → runtime proof.

### References

- `AliProgrammin`: `d6facb5...`
- `ali-afk`: `327e5ea...`, engineering docs
- `HussainWorld`: `caafdb3...`

---

# 8. Cross-fork consensus — especially trustworthy signals

When multiple independent forks found the same issue, treat it as a high-confidence signal that we should verify immediately.

## 8.1 Pre-OTP/session authentication defects

Independent sources include:

- `thrzkr`
- `sama-elsawaf`
- `NooraBumjaid`
- our own Evidence

**Priority:** Critical.

## 8.2 Fee schedule vs stale merchant MDR

Independent sources include:

- `sama-elsawaf`
- `HussainWorld`
- `AliProgrammin`

**Priority:** Critical/High because it directly affects money.

## 8.3 Refund correctness/concurrency

Independent sources include:

- `sama-elsawaf`
- `thrzkr`
- `NooraBumjaid`
- `htshahid07-pdf`
- `Haaljafen`
- our Evidence

**Priority:** Critical.

## 8.4 Docker/runtime was incomplete/broken

Independent sources include:

- `ali-afk`
- `sama-elsawaf`
- `thrzkr`
- `Hasoooni2003`
- `emanqarooni`
- `Saraalsobah`

**Priority:** High because judges cannot evaluate a product that does not boot.

## 8.5 Webhook concurrency/security

Independent sources include:

- `sama-elsawaf`
- `NooraBumjaid`
- `Haaljafen`
- `ali-afk`

**Priority:** High/Critical depending on exact issue.

## 8.6 Balance/rebuild/settlement source-of-truth

Independent sources include:

- `HussainWorld`
- `saraisa12`
- `sama-elsawaf`
- our Evidence

**Priority:** Critical.

---

# 9. Things NOT to copy directly

The agent must not directly copy these without local verification:

1. **Exact migration numbers** — our branch may add migrations before the reference.
2. **Exact environment values/secrets** — never copy tokens or keys.
3. **Exact CPU allocations/capacity numbers** — measure ours.
4. **Entire instruction files** — competitors may have different decisions.
5. **Whole giant commits** such as:
   - `htshahid07-pdf` `d506837...`
   - `badriyaadnan` `8f4d46b...`
6. **Product behavior changes** such as optional merchant ID login unless required by the challenge.
7. **Alternative architectures simultaneously** — e.g. CORS and Vite proxy should be consciously chosen, not blindly layered.
8. **Any change to frozen `packages/money/`** unless absolutely unavoidable and documented.

---

# 10. Agent execution algorithm

For every candidate fix, use this loop:

```text
DISCOVER
  ↓
Read our Evidence bug entry
  ↓
Read our current implementation
  ↓
Read 1–3 independent reference implementations
  ↓
CONFIRM
  ↓
Write/reproduce a failing regression test on OUR branch
  ↓
IMPLEMENT
  ↓
Smallest architecture-compatible fix
  ↓
VERIFY
  ↓
Focused test
  ↓
Subsystem suite
  ↓
Full relevant suite
  ↓
Runtime probe if applicable
  ↓
DOCUMENT
  ↓
Evidence file + commit
```

If the local test does not reproduce the alleged bug, do not modify code until the discrepancy is understood.

---

# 11. Evidence format for borrowed/mined fixes

For every applied fix, create/update:

`Evidence/fork_mined_fixes.md`

Use entries like:

```markdown
## <Issue name>

### Local status before
Confirmed / Already fixed / Not reproducible

### Local root cause
<our own explanation>

### References inspected
- repo:
- branch:
- commit:
- why useful:

### Implementation adopted
<what concept was ported; do not claim code ownership from the reference>

### Local files changed
- ...

### Regression test
- ...

### Commands run
```text
...
```

### Result

- focused tests:
- full tests:
- runtime:

### Differences from reference

<important architecture differences>

### Remaining risk

...

```

---

# 12. Required final agent report

After each batch, the agent must output:

```text
BATCH N RESULT

Issues investigated:
Issues reproduced:
Issues already fixed:
Issues not reproducible:

Fixes applied:
1.
2.
3.

Reference repositories inspected:
- repo / branch / commit

Files changed:
- ...

Migrations added:
- ...

Regression tests added:
- ...

Commands run:
- ...

Focused test result:
Full TS result:
Go result:
Docker/runtime result:

Evidence updated:
- ...

Known failures:
- ...

Recommended next batch:
- ...
```

---

# 13. Copy-paste task prompt for the coding agent

Use the following prompt together with this report:

> Read `FORK_INTELLIGENCE_AND_ADAPTATION_REPORT.md` in full.
>
> You are authorized to inspect the public reference forks and commits listed in that report and use them to accelerate work in our repository.
>
> Do not blindly merge or mass-cherry-pick competitor forks. For each fix, first inspect our current implementation and Evidence, reproduce/confirm the issue locally, inspect the focused reference commit(s), adapt the smallest correct implementation to our architecture, add or port a regression test, run the relevant test suites, and document our own verification.
>
> Work in the batch order defined by the report. Start with the earliest incomplete batch. If Batch 1 fixes are already present, verify them and continue to Batch 2 rather than redoing them.
>
> Prioritize correctness and high-severity money/security bugs before UI polish.
>
> Do not modify `packages/money/` without explicit architectural justification.
>
> Prefer forward migrations over editing historical migrations.
>
> Do not weaken or delete tests simply to make the suite pass.
>
> Do not claim another fork's test result or capacity number as ours.
>
> Maintain `Evidence/fork_mined_fixes.md` as you work.
>
> Actually modify, test and document the repository; do not only produce recommendations.
>
> At the end of each batch, emit the exact final report format defined in this file.

---

# 14. Suggested immediate next move for our repository

Based on the current audit state, the most efficient order is:

1. Finish/verify authentication + runtime quick fixes.
2. Payment-link atomicity/expiry/crash recovery.
3. Refund/FP-300 correctness and UI.
4. Webhook concurrency/SSRF.
5. Settlement/fee/balance correctness.
6. Reporting/KYC/admin hardening.
7. Docker/Dilmune/load/capacity.
8. UI/evidence polish.

The highest-value first reference commits to inspect are:

```text
sama-elsawaf/fils-pay
980278cdd396372d4ea3bb7c49f35efe14998fb4
cb17048a8895681d5e28d3d5222e5f38039d998a
c54488bf46d14d16bf4e9a9f54e4db0cffaba8e6
2ba122ec1b514929275a67f16832f69f1b9a4d72
b1f678153253e2bd5cfbe0f1aa01958b70011121
8078f33acbc352d18c40184c6329615289fe5678
7da7706c7b80b378960f5868eb687c27cbda11cf
dc6fa83d2d0ce012c9a186f88edd4d42fdbb0e99
5b85b1755ebe31fb734a8d42ded468fe24e5da4a
ba9c80ae1e01709ff46bcec580c9dba51e3f38cb

AliProgrammin/fils-pay
35712b93bf088c1831b6ef492bb0a49f55920be5
482b3c4a88d67a5cb8a2599e81c80925617de513
c318c8bd4a372a02a4d9e8d30192f541049dc5df
d43b390d901d34bfe5511ca200acbbbe682b4384

ali-afk/fils-pay
33f0201b382689b10f51207bb54a8c7be5ba53b9
f2df1313ffeb6226b1d6e9d0a11dd1558919898c
327e5ea28122fc1a60edee9853ee9ad81461521a
a808bf7336117e90f957f14f7022e76cf51d8a23

HussainWorld/fils-pay
38b6269d99aa94412d5c5e2213b1a69b099bf7cc
e16ce75e4cd5bf022285fdd151a88bafa3beb8a0
3f28439a9639cf74a1e41a2f5339033808a055fd

saraisa12/fils-pay
4a531564c1724550320b4075397a649dcce7abfd

thrzkr/fils-pay
5c3fa2df2202b15d72bd975f3afa1491a4586e26
a9c9fff12258ca251e0bb29ae4e12f6425f1b180
4318caaca47a60fc174775f1871d4b967e524270
```

---

# 15. Final principle

The fork network should be treated as a parallel research team.

We should steal **time**, not blindly steal **state**:

- use their discovered root causes;
- use their regression-test ideas;
- use their deployment lessons;
- use independent agreement as confidence;
- then prove the behavior on our own branch.

A fix is only ours when our repository reproduces the bug, our implementation resolves it, and our own tests/runtime evidence prove it.
