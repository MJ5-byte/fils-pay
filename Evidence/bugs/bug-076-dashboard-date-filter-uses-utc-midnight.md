# BUG-076 — Dashboard Date Filter Generates UTC Midnight Instead of Bahrain Midnight

## 1. Summary

A merchant picking 30 Oct sends `2026-10-30T00:00:00.000Z`, which is 03:00 Bahrain.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Frontend
- Affected Component: apps/web/src/format.ts
- Reachability: Reachable on any date range selection in merchant dashboard
- Original Contributors / Sources: CODE-020b, ADR-0003

## 3. Root Cause

The amendment comment was added without changing the string.

## 4. Affected Files and Functions

- `apps/web/src/format.ts:33-36`

```ts
// fixed, uses bahrain time now — am
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}
```

The `Z` is UTC. Settlement business days are Asia/Bahrain (UTC+3), 00:00 to the next 00:00.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

A merchant picking 30 Oct sends `2026-10-30T00:00:00.000Z`, which is 03:00 Bahrain. Transactions from 00:00 to 03:00 Bahrain on that date fall into the previous filter day. The comment on the previous line says this was fixed. The function still appends `Z`.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/web/src/format.ts:33-36`

```ts
// fixed, uses bahrain time now — am
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}
```

The `Z` is UTC. Settlement business days are Asia/Bahrain (UTC+3), 00:00 to the next 00:00.

Technical details:
A merchant picking 30 Oct sends `2026-10-30T00:00:00.000Z`, which is 03:00 Bahrain. Transactions from 00:00 to 03:00 Bahrain on that date fall into the previous filter day. The comment on the previous line says this was fixed. The function still appends `Z`.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Dashboard totals for a calendar day do not match the settlement batch for that Bahrain day. The first three hours of every local day are missing from "today" and appear in "yesterday". This is the same three-hour slice as Bug 27, on the read side.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: CODE-020b, ADR-0003. Legacy file: `bug-71-dashboard-date-filter-uses-utc-midnight.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

Return `${dateValue}T00:00:00.000+03:00` (or format the instant in `Asia/Bahrain`). Use one helper for every `from`/`to` filter.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-71-dashboard-date-filter-uses-utc-midnight.md`

## 17. Evidence References

`apps/web/src/format.ts`, `bug-71-dashboard-date-filter-uses-utc-midnight.md`
