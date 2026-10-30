# FilsPay: findings report

One entry per bug: what is wrong, why it happens, what it breaks, how it was fixed
and how the fix was checked. "Fixed" means a code change plus tests.
"Worked around" means the app is still wrong and only our local setup avoids it.

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 1 | CSV adjustment import reads amounts 10x too small | `apps/api/src/admin/adjustmentCsvParsing.ts` | Fixed |
| 2 | Migration 0054 cannot apply on a fresh database | `db/migrations/0054_views.sql` | Fixed |
| 3 | Migration 0055 cannot apply on a fresh database | `db/migrations/0055_chart_of_accounts_suspense.sql` | Fixed |
| 4 | The built-in dev webhook key is invalid, so the API and the seed refuse to start | `apps/api/src/config.ts` | Worked around |

Fixes for bugs 1-3 are in commit `12fdf81` (it also contains our local setup files).

---

## Bug 1: CSV adjustment import reads amounts 10x too small

**File:** `apps/api/src/admin/adjustmentCsvParsing.ts`

**What is wrong:** `4.75` is imported as 475 fils (0.475 BD) instead of 4750 fils. A third
decimal is silently dropped: `4.756` becomes 475 and `0.005` becomes 0.

**Why it happens:** the code called `parseDecimalMinor`, a helper whose default is 2 decimals
(dollars and cents). BD has 3 decimals (1 BD = 1000 fils). The correct parser,
`parseBhdToFils`, already existed in `packages/money` and was not used. This is the mistake
ADR-0001 warns about.

**What it breaks:** every row of an admin "Import adjustments" CSV posts a ledger entry and a
merchant balance change that is 10x too small, with no error shown.

**Fix:** use `parseBhdToFils`. It also rejects more than 3 decimals instead of truncating them.

**Tests and evidence:**
- All 20 existing tests passed while the code was wrong, because they asserted the wrong
  numbers (475, 125, a total of 600, 350, 500). The tests had the bug baked in.
- After the fix, exactly three tests failed, each on a wrong expected number. We corrected
  those expectations (4750, 1250, 6000, 3500, 5000) and added 4 parser tests for 3-decimal
  amounts, a kept third decimal, negative amounts, and rejecting 4 decimals. 24/24 pass and
  `tsc --noEmit` is clean.
- History: commit `9567ea0` (Yousif) already said "the csv import is 10x off... the test is
  scripture"; commit `6f462e1` then marked it intentional.

---

## Bug 2: Migration 0054 cannot apply on a fresh database

**File:** `db/migrations/0054_views.sql`

**What is wrong:** `npm run migrate` stops at 0054 with
`relation "settlement_batch_events" does not exist`.

**Why it happens:** the view `v_unbatched_capture_events` reads from a table that no migration
creates. The handover notes say 0054-0056 were abandoned branches that "no database ever ran",
yet the files are in the migrations folder.

**What it breaks:** a new environment cannot be created from the repo, so the stack cannot be
rebuilt or deployed reproducibly.

**Fix:** "not yet batched" is `transaction_events.settlement_batch_id IS NULL` (migration 0023),
the same rule `CloseBatch` uses. The view now uses that and includes `partially_captured`.

**Evidence:** all 72 migrations applied in order on a clean PostgreSQL 16 after the fix.

**Not changed, to investigate (see leads):** the view `merchant_payable_position` in the same
file.

---

## Bug 3: Migration 0055 cannot apply on a fresh database

**File:** `db/migrations/0055_chart_of_accounts_suspense.sql`

**What is wrong:** it inserts into columns `code`, `account_type` and `description`, which
`chart_of_accounts` does not have, with a kind (`suspense`) its CHECK constraint rejects.

**Why it happens:** written against a table shape that never existed (real columns: `id`,
`name`, `kind`; kinds: asset, liability, revenue).

**What it breaks:** same as bug 2. It was hidden behind bug 2 and appeared once 0054 was fixed.

**Fix:** use the real columns and model the suspense accounts as `asset`, like
`scheme_rounding_residue` in 0007.

**Evidence:** same clean-database run as bug 2.

---

## Bug 4: The built-in dev webhook key is invalid (worked around, not fixed in code)

**File:** `apps/api/src/config.ts` (`DEV_FALLBACK_WEBHOOK_KEY_B64`)

**What is wrong:** the docs say a dev key is used when none is set. That key decodes to 34
bytes, and the code requires exactly 32, so the API and `npm run seed` stop at startup with
`WEBHOOK_SECRET_ENCRYPTION_KEY must base64-decode to exactly 32 bytes, got 34`.

**What it breaks:** the documented "works out of the box" local run does not work.

**Current status:** `ops/docker-compose.local.yml` sets a valid random dev-only key. The
fallback constant itself is still wrong.

---

## Setup problems found (not app bugs)

- `ops/Dockerfile.node` and `ops/Dockerfile.go` are referenced by the compose file and the ops
  README but were never committed (checked all 57 commits). We wrote replacements.
- The API sends no CORS headers, so the Vite frontends cannot call it directly. We added a `/v1`
  proxy in both Vite configs (with `.env.local` files setting the API base URL to empty).

## Leads: read in the code, not yet reproduced or fixed

- Payment-link expiry is judged against `submittedAt`, a time sent by the buyer's browser.
- OTP codes come from `Math.random()` (`apps/api/src/lib/random.ts`).
- Two-person credit approval compares `displayName` instead of the admin user id.
- Refunds: the transaction row is read without a lock, and the refundable amount is computed
  from the authorized amount instead of the captured amount.
- Split payouts: each child share is rounded separately, so fils can be lost, and the balance
  cache is reduced by the allocated total instead of the batch net payout.
- `NetPayableFils` uses `float32`.
- The scheme export `amount` column is computed from the untruncated gross, not the truncated
  amount.
- The "Rebuild cached balances" button reads `merchant_payable_position`, a view over
  `scheme_export_lines`, instead of the ledger.
- `payments/discountAdjustment.ts` parses money with `parseFloat(...) * 100`.
- Uploading the same adjustment CSV twice applies it twice (no idempotency, despite a comment
  assuming one).
- `ops/.env.docker` contains an acquirer callback signing secret, and `.gitignore` does not
  ignore that file.
