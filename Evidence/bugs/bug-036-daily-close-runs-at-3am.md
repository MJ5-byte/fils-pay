# BUG-036 — Daily Settlement Close Runs at 03:15 Bahrain Time Instead of Midnight

## 1. Summary

Until 03:00 Bahrain (00:00 UTC), "today" in UTC is still yesterday.

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/internal/scheduler/daemon.go
- Reachability: Reachable on daily settlement daemon execution
- Original Contributors / Sources: Clue 'Daily close at 3am', ADR-0003

## 3. Root Cause

`BusinessDayWindow` does not convert `now` into Asia/Bahrain **before** reading Y/M/D. Agent files claim UTC midnight is the rule; ADR-0003 / ARCHITECTURE / HANDOVER say Asia/Bahrain.

## 4. Affected Files and Functions

- `apps/settlement/internal/scheduler/daemon.go:80-90` — `now := time.Now().UTC()` then `BusinessDayWindow(now)`
- `apps/settlement/internal/settlement/window.go:42-47` — `date.Date()` uses the **location of `date`**. A UTC instant's Y/M/D is the UTC calendar date, then that Y/M/D is placed at Bahrain midnight.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

Until 03:00 Bahrain (00:00 UTC), "today" in UTC is still yesterday. `todayStart` is therefore yesterday's Bahrain midnight, `dueAt` has already passed, and `businessDate := todayStart.AddDate(0,0,-1)` closes **two** days ago. After 03:00 Bahrain, UTC date catches up and the daemon finally closes "yesterday." Ops sees the run at ~03:15. Comment on line 89: *"logs show the close ~03:15 local not 00:15??"*

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/scheduler/daemon.go:80-90` — `now := time.Now().UTC()` then `BusinessDayWindow(now)`
- `apps/settlement/internal/settlement/window.go:42-47` — `date.Date()` uses the **location of `date`**. A UTC instant's Y/M/D is the UTC calendar date, then that Y/M/D is placed at Bahrain midnight.

Technical details:
Until 03:00 Bahrain (00:00 UTC), "today" in UTC is still yesterday. `todayStart` is therefore yesterday's Bahrain midnight, `dueAt` has already passed, and `businessDate := todayStart.AddDate(0,0,-1)` closes **two** days ago. After 03:00 Bahrain, UTC date catches up and the daemon finally closes "yesterday." Ops sees the run at ~03:15. Comment on line 89: *"logs show the close ~03:15 local not 00:15??"*

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

The close of "yesterday" does not run until ~03:15 Bahrain. From 00:00 to 03:00 the daemon instead targets the day before yesterday (a no-op once that day is already closed). Window bounds stay Bahrain midnights; captures are not filed into the wrong day. They just sit unbatched for those three hours, and a manual run in that window can freeze the wrong date (Bug 61).

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: Clue 'Daily close at 3am', ADR-0003. Legacy file: `bug-27-daily-close-runs-at-3am.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`now = time.Now().In(businessDayLocation)` (or convert inside `BusinessDayWindow` before `Date()`).

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-27-daily-close-runs-at-3am.md`

## 17. Evidence References

`apps/settlement/internal/scheduler/daemon.go`, `bug-27-daily-close-runs-at-3am.md`
