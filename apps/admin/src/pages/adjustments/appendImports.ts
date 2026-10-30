import type { AdjustmentImportSummary } from "../../types.js";

/** Adds a freshly loaded page after the ones already shown, skipping ids already present. */
export function appendImports(
  current: AdjustmentImportSummary[],
  next: AdjustmentImportSummary[],
): AdjustmentImportSummary[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}
