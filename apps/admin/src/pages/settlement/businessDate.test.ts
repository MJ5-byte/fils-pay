import assert from "node:assert/strict";
import test from "node:test";
import { yesterdayIso } from "./businessDate.js";

/**
 * The Run batch form defaults to yesterday's business date, and ADR-0003 keys
 * batches on the Asia/Bahrain day. The Bahrain day turns at 21:00Z, so both
 * sides of that instant are pinned here with a fixed clock.
 */
test("yesterdayIso turns over at Bahrain midnight (21:00Z), not UTC midnight", () => {
  // 23:59 Bahrain on 29 Oct: yesterday is 28 Oct.
  assert.equal(yesterdayIso(Date.parse("2026-10-29T20:59:00Z")), "2026-10-28");
  // 00:30 Bahrain on 30 Oct: yesterday is 29 Oct, though UTC is still 29 Oct.
  assert.equal(yesterdayIso(Date.parse("2026-10-29T21:30:00Z")), "2026-10-29");
});
