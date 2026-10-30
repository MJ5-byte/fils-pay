import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRE_HOLDS_SQL } from "./expire_holds.js";

test("expiry flips status instead of deleting rows", () => {
  assert.match(EXPIRE_HOLDS_SQL, /^UPDATE holds SET status = 'expired'/);
  assert.doesNotMatch(EXPIRE_HOLDS_SQL, /DELETE/i);
});

test("expiry is scoped to active holds past expires_at in the same statement", () => {
  assert.match(EXPIRE_HOLDS_SQL, /WHERE status = 'active' AND expires_at < now\(\)$/);
});
