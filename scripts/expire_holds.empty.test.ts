import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsDelete } from "./expire_holds.js";

test("an empty expired set never produces a WHERE-less DELETE", () => {
  const { text, values } = buildExpiredHoldsDelete([]);
  // A night with nothing expired must delete zero rows, not every row.
  assert.equal(text, "DELETE FROM holds WHERE 1 = 0 AND status = 'active' AND expires_at < now()");
  assert.deepEqual(values, []);
  assert.doesNotMatch(text.toUpperCase(), /DELETE FROM HOLDS\s*$/);
});
