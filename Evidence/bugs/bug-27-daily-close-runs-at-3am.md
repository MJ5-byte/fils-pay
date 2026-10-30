# Bug 27 — Daily close runs ~03:15 Bahrain, not midnight + grace

**Severity:** High · **Area:** Settlement · **Clue:** Group chat — *"The daily close is running at 3am local, not midnight"*; Architecture — *"Settlement closes every day at midnight, Bahrain time (UTC+3)"*; clue_standalone.md clocks 07:58 vs 08:30 (trust the time written)

## Where
- `apps/settlement/internal/scheduler/daemon.go:80-90` — `now := time.Now().UTC()` then `BusinessDayWindow(now)`
- `apps/settlement/internal/settlement/window.go:42-47` — `date.Date()` uses the **location of `date`**. A UTC instant's Y/M/D is the UTC calendar date, then that Y/M/D is placed at Bahrain midnight.

## What's wrong
Until 03:00 Bahrain (00:00 UTC), "today" in UTC is still yesterday. `todayStart` is therefore yesterday's Bahrain midnight, `dueAt` has already passed, and `businessDate := todayStart.AddDate(0,0,-1)` closes **two** days ago. After 03:00 Bahrain, UTC date catches up and the daemon finally closes "yesterday." Ops sees the run at ~03:15. Comment on line 89: *"logs show the close ~03:15 local not 00:15??"*

## Why
`BusinessDayWindow` does not convert `now` into Asia/Bahrain **before** reading Y/M/D. Agent files claim UTC midnight is the rule; ADR-0003 / ARCHITECTURE / HANDOVER say Asia/Bahrain.

## What it breaks
The close of "yesterday" does not run until ~03:15 Bahrain. From 00:00 to 03:00 the daemon instead targets the day before yesterday (a no-op once that day is already closed). Window bounds stay Bahrain midnights; captures are not filed into the wrong day. They just sit unbatched for those three hours, and a manual run in that window can freeze the wrong date (Bug 61).

## Smallest fix
`now = time.Now().In(businessDayLocation)` (or convert inside `BusinessDayWindow` before `Date()`).
