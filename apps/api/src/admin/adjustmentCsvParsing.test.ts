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

test("amounts are BD with three decimals", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("5"), 5000);
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
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

test("a thousands comma in the amount is rejected, naming the row", () => {
  assert.throws(
    () => parseAdjustmentCsv(`merchantId,amount,reason
${MERCHANT_A},1.000,ok
${MERCHANT_B},1,250.500,fix
`),
    (err: Error & { code?: string }) => err.code === "invalid_csv_row" && /row 2 has 4 columns/.test(err.message),
  );
});

test("a quoted reason containing commas still imports", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason
${MERCHANT_A},4.750,"fee, tax and ""late"" fix"
`);
  assert.deepEqual(rows, [{ merchantId: MERCHANT_A, amount: "4.750", reason: 'fee, tax and "late" fix' }]);
});

test("a quoted amount with a comma stays one column", () => {
  const rows = parseAdjustmentCsv(`merchantId,amount,reason
${MERCHANT_A},"1,250.500",fix
`);
  assert.equal(rows[0]?.amount, "1,250.500");
});

test("an unterminated quote is rejected", () => {
  assert.throws(() => parseAdjustmentCsv(`merchantId,amount,reason
${MERCHANT_A},4.750,"oops
`), /unterminated quote/);
});

test("an amount with a thousands comma is rejected as invalid_amount, quoted or not", () => {
  const [row] = parseAdjustmentCsv(`merchantId,amount,reason\n${MERCHANT_A},"1,250.500",fix\n`);
  assert.throws(
    () => parseAdjustmentAmountFils(row?.amount ?? ""),
    (err: Error & { code?: string }) => err.code === "invalid_amount",
  );
  assert.equal(parseAdjustmentAmountFils("1250.500"), 1250500);
});
