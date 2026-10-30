import assert from "node:assert/strict";
import test from "node:test";
import { statusLabel } from "./format.js";

test("statusLabel turns a raw status or reason code into readable text", () => {
  assert.equal(statusLabel("pending_approval"), "Pending approval");
  assert.equal(statusLabel("dispute_resolution"), "Dispute resolution");
  assert.equal(statusLabel(null), "");
  assert.equal(statusLabel(undefined), "");
});
