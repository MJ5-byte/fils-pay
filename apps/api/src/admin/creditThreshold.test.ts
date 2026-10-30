/**
 * Pure unit tests for the maker-checker threshold and the credit fee
 * reversal. No database, no app — both functions are total functions of
 * their arguments.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRateFils, toFils, ZERO_FILS } from "@filspay/money";
import {
  CREDIT_APPROVAL_THRESHOLD_FILS,
  calculateCreditFeeReversal,
  creditRequiresSecondApprover,
} from "./creditThreshold.js";

test("the approval threshold is 50.000 BD expressed in integer fils", () => {
  assert.equal(CREDIT_APPROVAL_THRESHOLD_FILS, 50_000);
});

test("a credit at exactly the threshold needs one operator; a fil more needs two", () => {
  assert.equal(
    creditRequiresSecondApprover({ baseAmountFils: toFils(50_000), feeReversalFils: ZERO_FILS }),
    false,
    "the limit is inclusive: 50.000 BD is within one operator's discretion",
  );
  assert.equal(
    creditRequiresSecondApprover({ baseAmountFils: toFils(50_001), feeReversalFils: ZERO_FILS }),
    true,
  );
});

test("a credit well below the threshold needs one operator, well above it needs two", () => {
  assert.equal(
    creditRequiresSecondApprover({ baseAmountFils: toFils(1_000), feeReversalFils: ZERO_FILS }),
    false,
  );
  assert.equal(
    creditRequiresSecondApprover({ baseAmountFils: toFils(60_000), feeReversalFils: ZERO_FILS }),
    true,
  );
});

test("a modest credit carrying a fee reversal still needs only one operator", () => {
  assert.equal(
    creditRequiresSecondApprover({
      baseAmountFils: toFils(40_000),
      feeReversalFils: toFils(1_100),
    }),
    false,
  );
});

test("a large credit carrying a fee reversal still needs two", () => {
  assert.equal(
    creditRequiresSecondApprover({
      baseAmountFils: toFils(120_000),
      feeReversalFils: toFils(3_300),
    }),
    true,
  );
});

test("the fee reversal is exactly applyRateFils — the platform's one rate primitive", () => {
  for (const [amount, bps] of [
    [50_000, 275],
    [10_000, 250],
    [7_777, 199],
    [1, 250],
    [123_456, 325],
  ] as Array<[number, number]>) {
    assert.equal(
      calculateCreditFeeReversal(toFils(amount), bps, 0),
      applyRateFils(toFils(amount), bps),
      `${amount} fils @ ${bps} bps`,
    );
  }
});

test("a zero-rate merchant gets a zero fee reversal, not a rounding artefact", () => {
  assert.equal(calculateCreditFeeReversal(toFils(99_999), 0, 0), 0);
});

test("the fee reversal rounds half-to-even, like every other fee in the platform", () => {
  // 10 fils @ 250 bps = 0.25 -> 0; 30 @ 250 = 0.75 -> 1; the tie at .5
  // breaks to the even neighbour, never away from zero.
  assert.equal(calculateCreditFeeReversal(toFils(10), 250, 0), 0);
  assert.equal(calculateCreditFeeReversal(toFils(30), 250, 0), 1);
  assert.equal(calculateCreditFeeReversal(toFils(20), 250, 0), 0, "0.5 -> 0, the even neighbour");
  assert.equal(calculateCreditFeeReversal(toFils(60), 250, 0), 2, "1.5 -> 2, the even neighbour");
});
