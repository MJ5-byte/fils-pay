import assert from "node:assert/strict";
import { test } from "node:test";
import { appendImports } from "./appendImports.js";
import type { AdjustmentImportSummary } from "../../types.js";

function imp(id: string): AdjustmentImportSummary {
  return {
    id,
    uploadedByAdminUserId: "admin",
    originalFilename: `${id}.csv`,
    rowCount: 1,
    appliedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

test("appends the next page after the pages already shown", () => {
  const merged = appendImports([imp("a"), imp("b")], [imp("c")]);
  assert.deepEqual(merged.map((i) => i.id), ["a", "b", "c"]);
});

test("drops rows already shown so a repeated page does not duplicate them", () => {
  const merged = appendImports([imp("a"), imp("b")], [imp("b"), imp("c")]);
  assert.deepEqual(merged.map((i) => i.id), ["a", "b", "c"]);
});
