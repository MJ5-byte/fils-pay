/**
 * Unit tests for the adjustment CSV parser. Pure — no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils, parseAdjustmentCsv } from "./adjustmentCsvParsing.js";

test("a non-numeric amount throws", () => {
  assert.throws(() => parseAdjustmentAmountFils("not-a-number"), /could not parse amount/);
});

test("an empty amount throws", () => {
  assert.throws(() => parseAdjustmentAmountFils(""), /could not parse amount/);
});

// BD has THREE decimals: 1 BD = 1000 fils. These lock in the correct reading
// of a CSV amount (the importer used to read "4.75" as 475 fils, 10x too small).
test("amounts are parsed as BD with three decimals (1 BD = 1000 fils)", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4_750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4_750);
  assert.equal(parseAdjustmentAmountFils("10.00"), 10_000);
  assert.equal(parseAdjustmentAmountFils("12"), 12_000);
});

test("the third decimal is kept, never silently dropped", () => {
  assert.equal(parseAdjustmentAmountFils("4.756"), 4_756);
  assert.equal(parseAdjustmentAmountFils("0.005"), 5);
});

test("negative amounts keep their sign", () => {
  assert.equal(parseAdjustmentAmountFils("-3.50"), -3_500);
  assert.equal(parseAdjustmentAmountFils("-0.001"), -1);
});

test("more than three decimals is rejected instead of truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7561"), /could not parse amount/);
});

// ------------------------------------------------------------ csv splitting

const MERCHANT_A = "11111111-1111-4111-8111-111111111111";
const MERCHANT_B = "22222222-2222-4222-8222-222222222222";

test("a well-formed CSV splits into rows", () => {
  const rows = parseAdjustmentCsv(
    `merchantId,amount,reason\n${MERCHANT_A},4.750,statement correction\n${MERCHANT_B},-1.250,duplicate refund\n`,
  );
  assert.deepEqual(rows, [
    { merchantId: MERCHANT_A, amount: "4.750", reason: "statement correction" },
    { merchantId: MERCHANT_B, amount: "-1.250", reason: "duplicate refund" },
  ]);
});

test("a row with no reason column omits the reason", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason\n${MERCHANT_A},4.750\n`);
  assert.deepEqual(rows, [{ merchantId: MERCHANT_A, amount: "4.750" }]);
});

test("blank lines are ignored", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason\n\n${MERCHANT_A},1.000,x\n\n`);
  assert.equal(rows.length, 1);
});

test("a CSV with only a header throws", () => {
  assert.throws(() => parseAdjustmentCsv("merchantId,amount,reason\n"), /at least one data row/);
});

test("an empty CSV throws", () => {
  assert.throws(() => parseAdjustmentCsv("   \n  \n"), /at least one data row/);
});

test("a wrong header throws", () => {
  assert.throws(
    () => parseAdjustmentCsv(`merchant,value,note\n${MERCHANT_A},4.750,x\n`),
    /header must be merchantId,amount,reason/,
  );
});

test("a row missing its amount throws", () => {
  assert.throws(() => parseAdjustmentCsv(`merchantId,amount,reason\n${MERCHANT_A},,x\n`), /missing a merchantId or an amount/);
});
