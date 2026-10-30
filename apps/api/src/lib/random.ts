import { randomInt } from "node:crypto";

/**
 * Cryptographically secure helpers. OTP codes, payment-link slugs and invite
 * codes are all bearer secrets of one kind or another: anyone who can guess
 * the value can act with it, so none of them may come from Math.random().
 */

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(0, 10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
