# Bug 28 — Platform volume counter is `int32` and will wrap

**Severity:** High · **Area:** Settlement · **Clue:** HANDOVER — *"`platform_stats.total_processed_fils` is INTEGER, which is fine while it's only a counter."*; ADR-0001 columns are BIGINT; agent files say INTEGER is enough

## Where
- `apps/settlement/internal/settlement/platform_volume.go` — `updated := current + int32(batchGrossFils)`
- `db/migrations/0049_platform_stats.sql` — INTEGER column
- Used to flip a platform-wide MDR bonus once volume passes a threshold

## What's wrong
INT4 max is 2_147_483_647 fils (~2.15M BD). Addition wraps to negative with no check. A wrapped counter drops the volume-tier bonus and **raises** fees platform-wide.

## Why
A dashboard counter was typed as 32-bit. HANDOVER called it "fine"; it is not, and it feeds pricing.

## What it breaks
Silent fee spike for every merchant when the counter overflows. Wrong tier display before that.

## Smallest fix
`BIGINT` column + `int64` in Go; `SET total_processed_fils = total_processed_fils + $1`.
