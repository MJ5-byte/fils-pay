import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../api/client.js";
import { payFailure } from "./payFailure.js";

test("a capture refused for an expired hold says the authorization expired, not that a payment is in progress", () => {
  const f = payFailure(new ApiError(409, { error: "authorization_expired", stage: "capture" }));
  assert.match(f.message, /authorization expired/);
  assert.doesNotMatch(f.message, /already being processed/);
});

test("other refused captures say the payment could not be completed", () => {
  for (const [status, error] of [[409, "not_capturable"], [422, "capture_exceeds_remaining"]] as const) {
    assert.match(payFailure(new ApiError(status, { error, stage: "capture" })).message, /could not be completed/);
  }
});

test("a 409 with no stage still means a payment is in progress", () => {
  assert.match(payFailure(new ApiError(409, { error: "payment_link_processing" })).message, /already being processed/);
});

test("terminal link states stay terminal", () => {
  assert.equal(payFailure(new ApiError(410, { error: "payment_link_expired" })).kind, "terminal");
  assert.equal(payFailure(new ApiError(409, { error: "payment_link_already_paid" })).kind, "terminal");
});

test("declines, outages and an unpayable link each get their own sentence", () => {
  assert.match(payFailure(new ApiError(402, { error: "card_declined", stage: "authorize" })).message, /declined/);
  assert.match(payFailure(new ApiError(402, { error: "card_captured_declined", stage: "capture" })).message, /could not be completed/);
  assert.match(payFailure(new ApiError(502, { error: "acquirer_unavailable" })).message, /temporarily unavailable/);
  assert.equal(payFailure(new ApiError(409, { error: "payment_link_not_payable" })).kind, "terminal");
  assert.match(payFailure(new TypeError("Failed to fetch")).message, /try again/);
});

test("a lost reservation after a successful capture is terminal and shows the payment reference", () => {
  const f = payFailure(new ApiError(409, { error: "payment_link_reservation_lost", transactionId: "txn_123" }));
  assert.equal(f.kind, "terminal");
  assert.match(f.message, /Do not pay again/);
  assert.match(f.message, /Payment reference: txn_123\./);
});

test("an invalid card number asks the buyer to check it, without echoing server field names", () => {
  const f = payFailure(new ApiError(422, { error: "invalid_card_number", message: "card.pan must be a valid card number" }));
  assert.match(f.message, /card number is not valid/);
  assert.doesNotMatch(f.message, /card\.pan/);
});

test("a reservation lost after capture is headed Payment received, not Unable to pay", () => {
  const f = payFailure(new ApiError(409, { error: "payment_link_reservation_lost", transactionId: "txn_9" }));
  assert.equal(f.kind, "terminal");
  assert.equal(f.kind === "terminal" ? f.title : undefined, "Payment received");
});

test("an unmapped refusal never shows the server message (codes and field names)", () => {
  const f = payFailure(new ApiError(400, { error: "invalid_request", message: "card.cvv is required and must be a string" }));
  assert.doesNotMatch(f.message, /card\.cvv|invalid_request/);
});
