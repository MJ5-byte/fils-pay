import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsDelete } from "./expire_holds.js";

test("the delete is scoped to exactly the ids it was handed", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  const { text, values } = buildExpiredHoldsDelete(ids);
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[]) AND status = 'active' AND expires_at < now()");
  assert.deepEqual(values, [ids]);
});

test("a single id still goes through the array predicate rather than a bare equality", () => {
  const { text, values } = buildExpiredHoldsDelete(["33333333-3333-3333-3333-333333333333"]);
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[]) AND status = 'active' AND expires_at < now()");
  assert.equal((values[0] as string[]).length, 1);
});

test("the delete re-checks status and expiry so a hold released after the read is spared", () => {
  const { text } = buildExpiredHoldsDelete(["44444444-4444-4444-4444-444444444444"]);
  assert.match(text, /AND status = 'active' AND expires_at < now\(\)$/);
});

