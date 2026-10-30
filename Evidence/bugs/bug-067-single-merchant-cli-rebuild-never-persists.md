# BUG-067 — Single-Merchant Balance Rebuild CLI Calculates Balance but Never Persists

## 1. Summary

The --merchant branch calls RebuildMerchantBalance, which only SELECTs the ledger sum, prints the computed value and returns. Only RebuildAllBalances performs the cache upsert.

## 2. Classification

- Severity: Medium
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Settlement and reconciliation
- Affected Component: apps/settlement/cmd/settlement/main.go, internal/ledger/rebuild.go
- Reachability: Reachable when operator runs rebuild-balances --merchant=<id>
- Original Contributors / Sources: Blind spot investigation BUG-013

## 3. Root Cause

The --merchant branch calls RebuildMerchantBalance, which only SELECTs the ledger sum, prints the computed value and returns. Only RebuildAllBalances performs the cache upsert.

## 4. Affected Files and Functions

`apps/settlement/cmd/settlement/main.go:141-159`; `apps/settlement/internal/ledger/rebuild.go:18-31,101-116`; `apps/settlement/internal/ledger/rebuild_test.go:61-108,111-158`.

## 5. Expected Behavior

rebuild-balances --merchant=<id> repairs that merchant's cached balance, as the command promises.

## 6. Actual Behavior

The command can exit successfully and print rebuilt=<correct sum> while merchant_balances remains wrong or absent.

## 7. Trigger Conditions

A merchant cache differs from its ledger, and an operator runs the merchant-scoped CLI variant. This report only reasons about the command; nothing was run.

## 8. Technical Evidence

main.go:154 calls ledger.RebuildMerchantBalance and lines 158-159 print then return. The entire helper in rebuild.go:20-30 is a SELECT plus return. The all-merchant variant has INSERT ... ON CONFLICT UPDATE at lines 111-116.

### Technical Analysis
The source path and concrete input/ordering conditions above establish the result statically. Client controls are not treated as server authorization boundaries.

## 9. Runtime Evidence

Not runtime-tested in this investigation. No matching existing runtime reproduction available.

## 10. Security / Financial / Functional Impact

Targeted operational recovery falsely appears complete and leaves merchant-visible cached values incorrect. An all-merchant rebuild is a much broader alternative.

## 11. Safe Reproduction

RebuildMerchantBalance tests assert returned sums only. RebuildAllBalances test checks persisted cache. No CLI-scoped test verifies persistence. Future case: incorrect cache, merchant-scoped command, then compare the cache and untouched peers.

## 12. Related Findings

CODE-020 documents the admin rebuild's wrong data source and the all-merchant ledger rebuild. This missing-write CLI branch is an independent root cause and not previously reported. No matching runtime artifact.

## 13. Documentation Contradictions

The observed implementation contradicts the expected contract or architectural guarantees.

## 14. Recommended Remediation

Persist the recomputed value in the single-merchant recovery path with appropriate locking, or clearly rename it to a read-only calculation and provide a real scoped rebuild. No fix implemented.

## 15. Remaining Questions and Limitations

Actual deployment scripts may call the all-merchant variant; source behavior of --merchant remains clear.

## 16. Original Reports Merged

`bug-13-single-merchant-cli-rebuild-never-persists.md`

## 17. Evidence References

Exact source locations above; prior source, documentation, runtime and forensic reports and bug registry searched for duplicates before allocation. Source comments are leads, not proof.
