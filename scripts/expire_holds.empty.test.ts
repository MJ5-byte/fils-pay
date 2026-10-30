import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsUpdate } from "./expire_holds.js";

test("an empty expired set never produces a WHERE-less UPDATE", () => {
  const { text, values } = buildExpiredHoldsUpdate([]);
  // An empty candidate set must leave every hold's status untouched.
  assert.equal(text, "UPDATE holds SET status = 'expired' WHERE 1 = 0 AND status = 'active' AND expires_at <= now()");
  assert.deepEqual(values, []);
  assert.match(text, /WHERE 1 = 0/);
});
