/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";

/** Builds the header the acquirer would send for a given payload — the same
 *  `t=<seconds>,v1=<hex>` shape webhooks/sign.ts uses outbound. */
function acquirerHeader(payload: unknown, secret: string, timestamp = 1_757_930_000): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("a correctly-signed callback verifies", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, acquirerHeader(payload, SECRET), SECRET);
  assert.deepEqual(result, { valid: true });
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, SECRET);
  const result = verifyAcquirerCallbackSignature({ callbackId: "acqcb_1", outcome: "confirmed_fraud" }, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, "acqsec_someone_elses_secret");
  const result = verifyAcquirerCallbackSignature(payload, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  const payload = { callbackId: "acqcb_1" };
  assert.equal(verifyAcquirerCallbackSignature(payload, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("an unsigned callback is rejected by default (malformed_header)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, undefined, SECRET);
  assert.deepEqual(result, { valid: false, reason: "malformed_header" });
});

test("an unsigned callback is accepted only when signature checking is explicitly turned off", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, undefined, SECRET, false);
  assert.deepEqual(result, { valid: true });
});
