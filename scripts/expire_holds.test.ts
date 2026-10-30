import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsUpdate } from "./expire_holds.js";

test("the janitor marks exactly the ids it was handed as expired and deletes nothing", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  const { text, values } = buildExpiredHoldsUpdate(ids);
  assert.equal(text, "UPDATE holds SET status = 'expired' WHERE id = ANY($1::uuid[]) AND status = 'active' AND expires_at <= now()");
  assert.doesNotMatch(text, /DELETE/i);
  assert.deepEqual(values, [ids]);
});

test("a single id still goes through the array predicate rather than a bare equality", () => {
  const { text, values } = buildExpiredHoldsUpdate(["33333333-3333-3333-3333-333333333333"]);
  assert.equal(text, "UPDATE holds SET status = 'expired' WHERE id = ANY($1::uuid[]) AND status = 'active' AND expires_at <= now()");
  assert.equal((values[0] as string[]).length, 1);
});

test("the update re-checks status and expiry so a hold released after the read is spared", () => {
  const { text } = buildExpiredHoldsUpdate(["44444444-4444-4444-4444-444444444444"]);
  assert.match(text, /AND status = 'active' AND expires_at <= now\(\)$/);
});

