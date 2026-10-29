import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload, verifySignature } from "./sign.js";

const SECRET = "whsec_test_secret";

test("signPayload/verifySignature round-trip over the raw body string: valid signature, fresh timestamp", () => {
  const body = JSON.stringify({ transactionId: "abc", amountCapturedFils: 4750 });
  const { signature } = signPayload(body, SECRET);
  const result = verifySignature(body, signature, SECRET);
  assert.deepEqual(result, { valid: true });
});

test("signature header format is t=<seconds>,v1=<hex>", () => {
  const { timestamp, signature } = signPayload('{"a":1}', SECRET, 1_700_000_000);
  assert.equal(timestamp, 1_700_000_000);
  assert.match(signature, /^t=1700000000,v1=[0-9a-f]{64}$/);
});

test("signing is byte-exact: a different serialization order of the same object produces a different signature", () => {
  // No canonicalization: the HMAC covers the exact bytes handed to it, so
  // reordering keys changes the signature even though the JSON is the same
  // object. This is what makes a real receiver's parse-free verification
  // work (see the dispatcher: body is stringified once and signed verbatim).
  const a = signPayload('{"a":1,"b":2,"c":{"x":1,"y":2}}', SECRET, 1_700_000_000);
  const b = signPayload('{"c":{"y":2,"x":1},"b":2,"a":1}', SECRET, 1_700_000_000);
  assert.notEqual(a.signature, b.signature);
});

test("a different payload produces a different signature", () => {
  const a = signPayload('{"amountFils":100}', SECRET, 1_700_000_000);
  const b = signPayload('{"amountFils":101}', SECRET, 1_700_000_000);
  assert.notEqual(a.signature, b.signature);
});

test("verifySignature is parse-free: a byte mismatch that parses to the same JSON still returns signature_mismatch", () => {
  const body = '{"amountFils":100}';
  const { signature } = signPayload(body, SECRET);
  const differentBytes = '{"amountFils":100 }';
  const result = verifySignature(differentBytes, signature, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verifySignature rejects a tampered payload (signature_mismatch)", () => {
  const body = '{"amountFils":100}';
  const { signature } = signPayload(body, SECRET);
  const result = verifySignature('{"amountFils":999}', signature, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verifySignature rejects the wrong secret (signature_mismatch)", () => {
  const body = '{"amountFils":100}';
  const { signature } = signPayload(body, SECRET);
  const result = verifySignature(body, signature, "whsec_wrong_secret");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verifySignature rejects a malformed header", () => {
  const body = '{"amountFils":100}';
  assert.equal(verifySignature(body, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifySignature(body, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifySignature(body, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("verifySignature enforces the timestamp tolerance window", () => {
  const body = '{"amountFils":100}';
  const nowSeconds = 1_700_000_000;
  const { signature } = signPayload(body, SECRET, nowSeconds - 400); // 400s stale, default tolerance 300s

  const result = verifySignature(body, signature, SECRET, { now: nowSeconds });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");

  // A wider tolerance accepts the same signature.
  const withinWideTolerance = verifySignature(body, signature, SECRET, {
    now: nowSeconds,
    toleranceSeconds: 1000,
  });
  assert.equal(withinWideTolerance.valid, true);
});

// YA: keep this test, it stops someone 'simplifying' to ===
test("verifySignature uses timingSafeEqualHex, not ===: a same-length wrong signature still returns signature_mismatch (not a thrown error)", () => {
  const body = '{"amountFils":100}';
  const { signature } = signPayload(body, SECRET);
  const [tPart] = signature.split(",");
  const wrongSameLength = `${tPart},v1=${"0".repeat(64)}`;
  const result = verifySignature(body, wrongSameLength, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});
