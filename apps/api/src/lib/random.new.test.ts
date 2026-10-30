/**
 * OTP codes, payment link tokens and invite codes are bearer secrets, so the
 * helpers must draw from crypto, never Math.random.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomDigits, randomFromAlphabet } from "./random.js";

test("random helpers do not depend on Math.random", () => {
  const original = Math.random;
  Math.random = () => 0;
  try {
    const digits = new Set(Array.from({ length: 50 }, () => randomDigits(6)));
    const tokens = new Set(Array.from({ length: 50 }, () => randomFromAlphabet("ABCDEFGH", 10)));
    assert.ok(digits.size > 1, "randomDigits must vary even when Math.random is pinned");
    assert.ok(tokens.size > 1, "randomFromAlphabet must vary even when Math.random is pinned");
  } finally {
    Math.random = original;
  }
});

test("randomDigits returns exactly n decimal digits", () => {
  for (let i = 0; i < 100; i++) {
    assert.match(randomDigits(6), /^\d{6}$/);
  }
});
