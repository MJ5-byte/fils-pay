import { randomInt } from "node:crypto";

/** Generates a string of `n` random decimal digits (e.g. "042817") from `crypto.randomInt`. */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet` via `crypto.randomInt`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
