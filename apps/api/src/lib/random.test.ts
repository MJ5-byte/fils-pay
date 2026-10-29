import assert from "node:assert/strict";
import { test } from "node:test";
import { generateOtpCode } from "../auth/otp.js";
import { randomFromAlphabet } from "./random.js";

test("random helpers stay unpredictable when Math.random is constant", () => {
  const original = Math.random;
  Math.random = () => 0.5;
  // A constant Math.random makes the old helpers return identical values, so differing values prove a crypto source.
  try {
    const firstToken = randomFromAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", 22);
    const secondToken = randomFromAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", 22);
    assert.match(firstToken, /^[A-Za-z0-9_-]{22}$/);
    assert.match(secondToken, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(firstToken, secondToken);

    const firstOtp = generateOtpCode(6);
    const secondOtp = generateOtpCode(6);
    assert.match(firstOtp, /^\d{6}$/);
    assert.match(secondOtp, /^\d{6}$/);
    assert.notEqual(firstOtp, secondOtp);
  } finally {
    Math.random = original;
  }
});
