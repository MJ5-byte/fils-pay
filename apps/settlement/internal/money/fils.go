// Package money is the Go port of packages/money/src/fils.ts's integer-fils
// arithmetic, matching its rounding exactly. int64 covers
// amount*rateBasisPoints at any realistic scale, so there are no bigint
// intermediates here.
package money

import "fmt"

// Fils is a validated integer number of fils. 1 BD = 1000 fils.
type Fils int64

// ApplyRateFils applies a rate expressed in basis points to an amount, e.g.
// ApplyRateFils(10000, 250) applies a 2.50% MDR to 10.000 BD and returns
// 250. Uses BankersRoundDiv for deterministic half-to-even rounding.
func ApplyRateFils(amount Fils, rateBasisPoints int64) Fils {
	return Fils(BankersRoundDiv(int64(amount)*rateBasisPoints, 10_000))
}

// BankersRoundDiv performs round-half-to-even integer division of
// numerator/denominator, matching packages/money/src/fils.ts's
// bankersRoundDiv's tie-breaking rule exactly, so Go and TypeScript never
// disagree about a shared rounding decision.
func BankersRoundDiv(numerator, denominator int64) int64 {
	if denominator == 0 {
		panic("BankersRoundDiv: denominator must not be zero")
	}
	negative := (numerator < 0) != (denominator < 0)
	absNum, absDen := abs64(numerator), abs64(denominator)
	quotient, remainder := absNum/absDen, absNum%absDen
	twiceRemainder := remainder * 2

	var rounded int64
	switch {
	case twiceRemainder < absDen:
		rounded = quotient
	case twiceRemainder > absDen:
		rounded = quotient + 1
	default: // exact tie: round to even
		if quotient%2 == 0 {
			rounded = quotient
		} else {
			rounded = quotient + 1
		}
	}
	if negative {
		return -rounded
	}
	return rounded
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// String satisfies fmt.Stringer for readable test failure output and log
// lines (fils integer, no unit conversion — never used for money display,
// which has no requirement in apps/settlement).
func (f Fils) String() string {
	return fmt.Sprintf("%dfils", int64(f))
}

// AllocateByWeights splits total into len(weights) non-negative shares
// proportional to weights, using the largest-remainder method (ties to the
// lower index), so the shares always sum to exactly total. Port of
// packages/money's allocateRemainder for integer weights.
func AllocateByWeights(total Fils, weights []int64) []Fils {
	shares := make([]Fils, len(weights))
	var weightSum int64
	for _, w := range weights {
		weightSum += w
	}
	if weightSum <= 0 || total <= 0 {
		return shares
	}
	remainders := make([]int64, len(weights))
	var allocated Fils
	for i, w := range weights {
		product := int64(total) * w
		shares[i] = Fils(product / weightSum)
		remainders[i] = product % weightSum
		allocated += shares[i]
	}
	for leftover := total - allocated; leftover > 0; leftover-- {
		best := -1
		for i := range weights {
			if best == -1 || remainders[i] > remainders[best] {
				best = i
			}
		}
		shares[best]++
		remainders[best] = -1
	}
	return shares
}
