# Bug 21 — Scheme file `amount` is rounded, ledger `amount_fils` is truncated (always over)

**Severity:** High · **Area:** Settlement · **Clue:** Finance — *"The scheme statement total is always a few fils higher than ours. It's always over, never under."*; ADR-0002

## Where
- `apps/settlement/internal/settlement/scheme_export.go:23-30` — `TruncateToSchemeAmount` vs `SchemeAmountBD`
- `apps/settlement/internal/settlement/batch.go:250-255` — inserts truncated fils **and** `float64(gross)/1000` into `NUMERIC(10,2)` (Postgres rounds half-up)
- ADR-0002 residue posting (`gross - truncated` → `scheme_rounding_residue`) is **not** in `CloseBatch`

## What's wrong
Two representations of the same line. When `gross % 10 >= 5`, `amount` (2dp BD) rounds **up** while `amount_fils` truncated **down**. Residue is never journaled, so the ledger cannot tie to the scheme file.

## Why
ADR-0002 option A was accepted and marked "implemented"; HANDOVER says YA did not get to the posting. MK replaced the 3dp column. The float BD column is what the scheme file uses.

## What it breaks
Every statement is a few fils high. March sweep (Bug 34) was a band-aid and posts the wrong residue anyway.

## Smallest fix
Store `amount` from the **truncated** fils (`truncated/1000` formatted to two decimals). Post `gross - truncated` to `scheme_rounding_residue` inside `CloseBatch` as ADR-0002 specifies.
