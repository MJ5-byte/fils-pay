# BUG-010 — Settlement Net Payout Computed in Float32 Causing Severe Precision Loss

## 1. Summary

`float32` has 24 bits of significand.

## 2. Classification

- Severity: Critical
- Confidence: High
- Verification Status: STATICALLY CONFIRMED
- Category: Ledger and financial calculations
- Affected Component: apps/settlement/internal/settlement/payable.go
- Reachability: Reachable during settlement batch processing
- Original Contributors / Sources: ADR-0001, YA commit Float32

## 3. Root Cause

A "readable BD" conversion in the hot path. The integer subtraction `grossFils - feeFils` is the definition of net.

## 4. Affected Files and Functions

- `apps/settlement/internal/settlement/payable.go:10-12`

```go
netBD := float32(grossFils)/1000 - float32(feeFils)/1000
return money.Fils(math.Round(float64(netBD) * 1000))
```

Used from `batch.go` when freezing `net_payout_fils`.

## 5. Expected Behavior

The component should correctly enforce its intended specification, business logic, and security constraints.

## 6. Actual Behavior

`float32` has 24 bits of significand. Above ~16.8 million fils (~16.8k BD) it cannot represent every integer fils. Rounding through BD and back fabricates or drops fils.

## 7. Trigger Conditions

Execution of the affected code path under normal or edge-case operational inputs.

## 8. Technical Evidence

Source code inspection:

- `apps/settlement/internal/settlement/payable.go:10-12`

```go
netBD := float32(grossFils)/1000 - float32(feeFils)/1000
return money.Fils(math.Round(float64(netBD) * 1000))
```

Used from `batch.go` when freezing `net_payout_fils`.

Technical details:
`float32` has 24 bits of significand. Above ~16.8 million fils (~16.8k BD) it cannot represent every integer fils. Rounding through BD and back fabricates or drops fils.

## 9. Runtime Evidence

No runtime reproduction artifact exists; defect verified through static source code and architectural analysis.

## 10. Security / Financial / Functional Impact

Wrong `net_payout_fils` on large batches. Downstream splits, payouts, and merchant balances inherit the error.

## 11. Safe Reproduction

Review the affected code and verify behavior using an isolated test harness without modifying production data.

## 12. Related Findings

Source tag: ADR-0001, YA commit Float32. Legacy file: `bug-20-net-payout-float32.md`.

## 13. Documentation Contradictions

The code implementation diverges from architectural documentation, ADR specifications, or developer comments.

## 14. Recommended Remediation

`return grossFils - feeFils`.

## 15. Remaining Questions and Limitations

None identified within the scope of static source inspection.

## 16. Original Reports Merged

`bug-20-net-payout-float32.md`

## 17. Evidence References

`apps/settlement/internal/settlement/payable.go`, `bug-20-net-payout-float32.md`
