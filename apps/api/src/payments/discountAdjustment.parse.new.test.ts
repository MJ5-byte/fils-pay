/**
 * Unit tests for parsePromotionalDiscountFils. Pure — no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePromotionalDiscountFils } from "./discountAdjustment.js";

test("BD discount parses to fils at 1000 fils per BD", () => {
  assert.equal(parsePromotionalDiscountFils("4.75"), 4750);
  assert.equal(parsePromotionalDiscountFils("4.750"), 4750);
  assert.equal(parsePromotionalDiscountFils("0.005"), 5);
});

test("negative, malformed or over-precise discounts are rejected", () => {
  assert.throws(() => parsePromotionalDiscountFils("-1.00"), /could not parse discount amount/);
  assert.throws(() => parsePromotionalDiscountFils("4.75abc"), /could not parse discount amount/);
  assert.throws(() => parsePromotionalDiscountFils("4.7555"), /could not parse discount amount/);
});
