import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/**
 * Webhook signing: a timestamped Stripe-`t=...,v1=...`-style signature
 * scheme over the EXACT bytes a delivery sends, and a constant-time
 * comparison in verifySignature.
 *
 * The signed string is `${timestamp}.${body}` where `body` is the
 * pre-serialized request body — the same string written on the wire. A
 * receiver verifies parse-free, over the raw received bytes; there is no
 * canonicalization, because canonicalizing re-derives a *different* string
 * than the wire carried (and Postgres JSONB re-orders keys on round-trip,
 * so no canonical order can ever match the bytes a receiver gets).
 *
 * — YA: wrote this one slowly. read it before copying it.
 */

export interface SignedPayload {
  /** unix seconds, the value folded into the signature */
  timestamp: number;
  /** header value: "t=<timestamp>,v1=<hex-hmac-sha256>" */
  signature: string;
}

/**
 * Computes the header value a delivery carries. `body` must be the exact
 * pre-serialized request body the transport will send (callers do
 * `JSON.stringify(...)` once and pass those bytes here and to the
 * transport); `secret` is the raw (decrypted) webhook secret — callers must
 * decrypt webhook_endpoints.secret_ciphertext (webhooks/secretCrypto.ts)
 * before calling this; sign.ts itself never touches encryption, only
 * signing.
 *
 * Signs `${timestamp}.${body}`, not the payload alone, so a receiver can
 * enforce its own freshness window using only what's in the header — a
 * captured genuine delivery can't be replayed by a third party at an
 * arbitrary later time with a signature that still looks fresh.
 */
export function signPayload(
  body: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedPayload {
  const signedString = `${timestamp}.${body}`;
  const signature = createHmac("sha256", secret).update(signedString).digest("hex");
  return { timestamp, signature: `t=${timestamp},v1=${signature}` };
}

interface ParsedSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifySignatureFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifySignatureResult {
  valid: boolean;
  reason?: VerifySignatureFailureReason;
}

/**
 * Re-derives the expected signature over the RAW body bytes — parse-free,
 * exactly like a real receiver must — and compares constant-time
 * (`timingSafeEqualHex`, never `===`). `body` is the exact received body
 * string; any re-serialization (key reorder, whitespace change, re-parse
 * round-trip) changes the bytes and must yield signature_mismatch. Used by
 * the end-to-end tests (the local receiver checks what the dispatcher
 * actually sent) and meant for a "test your webhook secret" merchant tool.
 */
// FH: tolerance is checked AFTER the compare — claude says that's a timing oracle on the timestamp
// doesnt matter, t is inside the mac — am
export function verifySignature(
  body: string,
  header: string,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
): VerifySignatureResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${body}`)
    .digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
