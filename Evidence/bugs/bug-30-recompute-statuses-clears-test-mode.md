# Bug 30 — Admin "recompute statuses" clears `test_mode`, so sandbox merchants enter real settlement

**Severity:** Critical · **Area:** Admin / settlement · **Clue:** Group chat — *"Test merchants keep showing up in the real settlement run"*; handwritten — *"what happens to test merchants when certain admin tools run?"*

## Where
- `apps/api/src/admin/transactionStatusRecompute.ts:26-30` — candidates exclude `authorized`, so `openAuthorizations` is always 0
- `apps/api/src/admin/merchantFlags.ts:10-17` — if `scanned > 0 && openAuthorizations === 0`, `UPDATE merchants SET test_mode = false`
- `apps/settlement/.../batch.go` — `CloseBatch` requires `test_mode = false`

## What's wrong
The tool is supposed to recompute transaction statuses. As a side effect it marks the merchant live. Because authorized txns are excluded from the scan, every merchant with any captured/settled history looks like "no open auths" and is flipped to live.

## Why
Sandbox-clearing heuristic bolted onto a status rebuild. Wrong candidate filter.

## What it breaks
Test captures hit production settlement, scheme export, and payouts.

## Smallest fix
Never auto-clear `test_mode` from this tool. If a live-promotion path is needed, make it an explicit admin action with a role check.
