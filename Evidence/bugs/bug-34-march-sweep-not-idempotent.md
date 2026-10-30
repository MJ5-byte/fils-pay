# Bug 34 — March residue sweep is not idempotent and uses the wrong window

**Severity:** High · **Area:** Scripts / ledger · **Clue:** Finance — *"someone ran it twice on staging and the gap doubled. Is it safe to run again? I wouldn't."*; ADR-0002 says the script covered March only because CloseBatch was supposed to take over

## Where
- `scripts/reconcile_march.ts:16-18, 27-30, 71-81` — `randomUUID()` per merchant per run; comment claims re-run is safe
- Residue = `captured_fils % 10` over a **UTC** month, not scheme-line truncation vs rounding (Bug 21)
- No `WHERE NOT EXISTS` / deterministic `entry_group_id`

## What's wrong
Each run posts a new balanced group. Two runs double the "fix." The amount is not the scheme residue ADR-0002 defined. The calendar is UTC, not Asia/Bahrain (ADR-0003).

## Why
A one-off was left in the tree and documented as safe.

## What it breaks
Re-running (or running on production after staging) fabricates ledger credits. Nobody can tell from the log file how many times it ran (one timestamp).

## Smallest fix
Deterministic `entry_group_id` + `INSERT … WHERE NOT EXISTS`. Do not run it at all once CloseBatch posts residue (Bug 21). If it must exist, use Bahrain March bounds and residue = `gross - truncated` per export line.
