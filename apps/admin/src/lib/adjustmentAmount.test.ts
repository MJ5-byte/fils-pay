import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentBhd } from "./adjustmentAmount.js";

test("parses BD text into exact signed fils", () => {
  assert.equal(parseAdjustmentBhd("0.5"), 500);
  assert.equal(parseAdjustmentBhd("-1.25"), -1250);
  assert.equal(parseAdjustmentBhd(" 4.755 "), 4755);
  assert.equal(parseAdjustmentBhd("-0.001"), -1);
  assert.equal(parseAdjustmentBhd("5"), 5000);
});

test("rejects zero, extra decimals and non-numbers", () => {
  for (const bad of ["0", "-0", "0.000", "1.2345", "abc", "", "1e3", "1,5", "--1", "+1"]) {
    assert.throws(() => parseAdjustmentBhd(bad), RangeError, bad);
  }
});
