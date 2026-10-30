# Bug 19 — CSV import treats BD as 2-decimal cents (10× too small, third digit dropped)

**Severity:** Critical · **Area:** Money / admin · **Clue:** Finance — *"I uploaded 4.755 BD and the ledger shows 4.750. I uploaded 4.75 BD and it shows 0.475. That's ten times less."*; commit `9567ea07`

## Where
- `apps/api/src/admin/adjustmentCsvParsing.ts:6-8` — `toFils(parseDecimalMinor(raw))`
- `apps/api/src/lib/decimal.ts:4-17` — `parseDecimalMinor(raw, decimals = 2)` pads/truncates the fraction to **2** places
- Correct parser: `packages/money` `parseBhdToFils` (ADR-0001)

## What's wrong
`4.75` becomes `475` fils (0.475 BD), not `4 750`. `4.755` is cut to two fraction digits (`75`) and then read as cents: `475` fils (0.475 BD), not 4.750 BD. The finance note's "ledger shows 4.750" does not match this parser. Locked tests encode the wrong expectation (`475`).

## Why
A cents-era helper (`decimals = 2`) is used for a 3-decimal currency. Agent files claim "1 BD = 100 cents" and "do not modify packages/money" — those are decoys. ADR-0001: 1 BD = 1000 fils, `parseBhdToFils` only.

## What it breaks
Every manual finance CSV under-credits merchants by 10× and silently drops the third decimal.

## Smallest fix
`return parseBhdToFils(raw)` (with `allowNegative` if needed). Do not use `parseDecimalMinor` for BHD.
