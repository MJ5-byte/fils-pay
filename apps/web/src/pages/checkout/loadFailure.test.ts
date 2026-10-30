import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../api/client.js";
import { loadFailureKind } from "./loadFailure.js";

test("only a 404 means the payment link does not exist", () => {
  assert.equal(loadFailureKind(new ApiError(404, { error: "not_found" })), "not_found");
});

test("a 503, 429 or 500 is a load error, not a missing link", () => {
  for (const status of [503, 429, 500]) {
    assert.equal(loadFailureKind(new ApiError(status, { error: "service_unavailable" })), "error");
  }
});

test("a network failure is a load error", () => {
  assert.equal(loadFailureKind(new TypeError("Failed to fetch")), "error");
});
