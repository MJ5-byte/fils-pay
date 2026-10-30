import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, describeError } from "./client.js";

test("describeError never shows a raw code or a developer message", () => {
  const overRefund = new ApiError(422, {
    error: "refund_exceeds_refundable",
    message: "amountFils is more than is still refundable",
  });
  assert.equal(describeError(overRefund), "That's more than is left to refund on this payment.");
  assert.equal(describeError(new ApiError(400, { error: "some_new_code" })), "That did not go through. Check the details and try again.");
  assert.equal(describeError(new ApiError(400, { error: "x", message: "amountFils must be positive" })), "That did not go through. Check the details and try again.");
  assert.equal(describeError(new ApiError(409, { error: "x", message: "This link has expired." })), "This link has expired.");
  assert.equal(describeError(new RangeError('parseBhdToFils: invalid BHD amount "1.23456"')), "Something went wrong. Try again.");
});
