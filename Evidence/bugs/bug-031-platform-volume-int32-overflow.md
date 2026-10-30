# BUG-031 — Platform Lifetime Volume Counter Uses 32-Bit Integer Overflowing at 2.1M BHD

## 1. Summary

INT4 max is 2_147_483_647 fils (~2.15M BD).

## 2. Classification

- Severity: High
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/settlement/internal/settlement/platform_volume.go
- Reachability: Reachable when cumulative volume reaches 2,147,483,647 fils
- Original Contributors / Sources: YA handover doc review

## 3. Root Cause

A dashboard counter was typed as 32-bit. HANDOVER called it "fine"; it is not, and it feeds pricing.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/platform_volume.go` — `updated := current + int32(batchGrossFils)`
- `db/migrations/0049_platform_stats.sql` — INTEGER column
- Used to flip a platform-wide MDR bonus once volume passes a threshold

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

INT4 max is 2_147_483_647 fils (~2.15M BD). Addition wraps to negative with no check. A wrapped counter drops the volume-tier bonus and **raises** fees platform-wide.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/platform_volume.go` — `updated := current + int32(batchGrossFils)`
- `db/migrations/0049_platform_stats.sql` — INTEGER column
- Used to flip a platform-wide MDR bonus once volume passes a threshold

Technical details:
INT4 max is 2_147_483_647 fils (~2.15M BD). Addition wraps to negative with no check. A wrapped counter drops the volume-tier bonus and **raises** fees platform-wide.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Silent fee spike for every merchant when the counter overflows. Wrong tier display before that.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: YA handover doc review. Legacy file: `bug-28-platform-volume-int32-overflow.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`BIGINT` column + `int64` in Go; `SET total_processed_fils = total_processed_fils + $1`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-28-platform-volume-int32-overflow.md`

## 17. Evidence References

`apps/settlement/internal/settlement/platform_volume.go`, `bug-28-platform-volume-int32-overflow.md`
