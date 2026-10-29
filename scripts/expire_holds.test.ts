import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsUpdate } from "./expire_holds.js";
import { buildDelete } from "./lib/sqlFilter.js";

test("expire flips every abandoned active hold with one atomic UPDATE", () => {
  assert.equal(
    buildExpiredHoldsUpdate(),
    "UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()",
  );
});

test("an empty candidate array can never delete the whole (or any) table", () => {
  const { text, values } = buildDelete("holds", { id: [] });
  assert.equal(text, "DELETE FROM holds WHERE FALSE");
  assert.deepEqual(values, []);
});