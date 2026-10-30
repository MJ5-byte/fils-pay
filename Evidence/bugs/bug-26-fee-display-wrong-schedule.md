# Bug 26 — Dashboard fee uses the newest row, billing uses the effective schedule

**Severity:** Medium · **Area:** Fees · **Clue:** Finance — *"It shows 245bps, but payments go through at 225bps. The two fee tables have different dates, and one was a backfill fix."*

## Where
- Display: `apps/api/src/fees/currentFeeScheduleDisplay.ts:32-37` — `ORDER BY created_at DESC LIMIT 1`
- Billing: `apps/api/src/fees/feeSchedule.ts` — `effective_from <= asOf ORDER BY effective_from DESC, created_at DESC`

## What's wrong
A backfill row created later with an earlier `effective_from` (245 bps) wins the dashboard. Live captures still pick the 225 bps row whose `effective_from` is current.

## Why
Display answers "most recently typed" instead of "in force now." Inline comments (Claude/MK) call this intentional.

## What it breaks
Support quotes the wrong MDR. Merchants think they were overcharged (or undercharged).

## Smallest fix
Call `getEffectiveMdrBps(..., new Date())` for display, same resolver as capture/settlement.
