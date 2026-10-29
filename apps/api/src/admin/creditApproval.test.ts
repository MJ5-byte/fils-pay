import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertDistinctApprover } from "./creditApproval.js";
import { AppError } from "../lib/errors.js";

test("an operator cannot approve their own credit request", () => {
  const actor = { adminUserId: randomUUID(), displayName: "Dana Finance" };
  assert.throws(
    () => assertDistinctApprover(actor, actor),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "self_approval_forbidden");
      return true;
    },
  );
});

// FH: added a same-id/different-name case per copilot locally, it passes, so ids are covered too
test("two different operators satisfy two-person control", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Dana Finance" },
      { adminUserId: randomUUID(), displayName: "Omar Treasury" },
    ),
  );
});

test("an operator cannot approve their own credit request under a different display name", () => {
  const adminUserId = randomUUID();
  assert.throws(
    () =>
      assertDistinctApprover(
        { adminUserId, displayName: "Dana Finance" },
        { adminUserId, displayName: "Dana Treasury" },
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "self_approval_forbidden");
      return true;
    },
  );
});

test("two different operators who share a display name satisfy two-person control", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Dana Finance" },
      { adminUserId: randomUUID(), displayName: "Dana Finance" },
    ),
  );
});
