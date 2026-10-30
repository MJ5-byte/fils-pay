# How we used AI, and how we checked it

**Setup.** We used Claude Code (desktop app). The repository's AI rules are in
`CLAUDE.md`. They replace the old "Order of the Prompt" guidance, which told
assistants to trust generated code and tests. The new rules are: verify, don't
defer; a failing test is information, not a verdict; and a comment that says
"intentional" or "Claude says" is a claim to check.

Our rule for every AI claim was: **the AI can propose, but only evidence closes
an item.** Evidence means a test that fails on the old code and passes on the
new, a query against the real database, or a request to the live server.

Below are three annotated excerpts from our sessions (lightly trimmed).

---

## 1. Tests that encoded the bug, and earlier "Claude says" comments that were wrong

The repo had several places where an earlier AI answer had been pasted in as
a fact. We treated each one as a claim to test.

> **Code comment (inherited):** `// FH: asked Claude, it said created_at is right for "most recently agreed" (see docblock). resolved`
>
> **Test (inherited):** `returns the most recently entered schedule even when an older period was backfilled later` → `assert.equal(current?.mdrBps, 245)`
>
> **AI (this session):** "The second test is exactly Fatima's case (225 entered, 245 backfilled later), and it asserts the wrong answer. I'll fix the query to match billing and correct that test."

**How we checked:** we read billing's own query (`getEffectiveMdrBps`:
`effective_from <= $2 ORDER BY effective_from DESC`) and the finance memo
("shows 245, payments go through at 225"). We changed both the display and the
test, then **swapped the old code back in and reran the tests**:

> `✖ shows the rate in effect (what billing charges), not a backdated correction entered later`
> `✖ API key rotation issues a new key atomically, audits it, and revokes the previous key`
> `ℹ pass 58 / ℹ fail 5` (old code) → `ℹ pass 377 / ℹ fail 0` (fixed code)

The same pattern caught two more inherited claims:

- `// FH: platform_stats.total_processed_fils is BIGINT ... (Claude double-checked the migration)`. Migration 0049 says `INTEGER`, and the Go code used `int32`, so the total wrapped negative past ~2.1M BD. Fixed in migration 0078, with a test above the int32 limit.
- `// am: re-running is safe, entry_group_id dedupes it`. The code calls `randomUUID()` on every run, so a second run posted everything again. We added a guard.

**Lesson:** an AI explanation pasted into a comment had become "the truth"
for the next developer. We only trusted it after reading the code it
described and running a test.

---

## 2. "It printed `|t`" was not evidence that it ran

Resetting the admin password took three attempts. Each time we asked for proof
from the server instead of trusting the report:

> **Us:** "Ends in |t"
>
> **AI:** checks the Dilmune console history → "The newest entry is still my DNS check from 41 minutes ago… the reset command isn't in this site's command history."
>
> **AI (later, after a read-only check against the database the API actually uses):**
> `superadmin@filspay.test|active|f` → "The API reads that same database, but the reset never changed the password (`f`)."

The AI's first guess was wrong. It suspected the seed script was overwriting
the password. It said so, then **disproved its own theory** with a second
query: one admin row, created 06:49, and no cron, timer or pm2 job runs the
seed. So the reset had never run. Only when the command showed up in the
history with `UPDATE 1 … |t` did we treat it as done.

The same happened with the API restart. The command printed
`SHADOWSTACK_REMOVED`, but the API's uptime was still 6,600 s and it still
allowed the old origin. The AI reported "the switch-over didn't actually run"
instead of accepting the printed success. On the rerun, uptime dropped to 35 s.

---

## 3. The AI's own fixes, verified before we believed them

Round 1 of fixes left this note: *"These Go changes could not be compiled or
tested in the audit environment."* In round 2 we didn't count those items as
done until they ran:

> **AI:** "The Go code compiles on this machine, which earlier audit work couldn't do. So I can test the untested Go fixes too."
>
> `--- FAIL: TestRefreshBalanceCache_OverwritesDriftedCache … diff.Rebuilt = 0, want 25000`
>
> **AI:** "These tests seed the balance through batches and scheme-export lines, which is the *old* source the button read from… the code is now right and the tests are out of date."

We didn't simply edit the tests until they passed. We checked that
`RefreshBalanceCache` now delegates to the same ledger query as the CLI
(`SUM(credit − debit) FROM ledger_entries WHERE account_id = 'merchant_payable'`),
which is exactly FP-203 ("the button and the CLI read from different places").
Only then did we move the test seed to ledger entries. After that, all Go
packages passed against Postgres.

For capacity, the AI's first load test returned **400 × 403**. Rather than
loosening the check, it looked up why: `merchant_not_approved`, because
payments require KYC approval, which is correct behaviour. The fix went into
the test setup, not the app. We also didn't accept the first throughput number
as our capacity estimate: we ran 10/20/40/150 buyers and saw that latency, not
throughput, was what changed (`docs/CAPACITY.md`).

---

## What we would do differently

- Put any AI explanation into a test, not a comment.
- Treat "it printed success" as a claim; check state (database rows, uptime, command history) instead.
- Keep throwaway helper files out of the repo. We committed one by mistake (a credentials note) and rotated the credential.
