import assert from "node:assert/strict";
import test from "node:test";
import { buildQuery } from "./api/query.js";
import { bhd, dash, dayStartIso, localDateTimeToIso, parseBhdAmount, parseRefundAmount, refundedFilsFromEvents, statusLabel, actorLabel } from "./format.js";
import type { TransactionEventDto } from "./types.js";

/**
 * The pure logic behind the dashboard's query strings and money/date display.
 * Both are places a silent bug does real damage: a dropped filter param makes
 * a page show rows it claimed to exclude, and a mis-scaled amount misstates
 * money. Everything else is rendering, verified against the running API
 * rather than here.
 */

test("buildQuery repeats array keys rather than encoding a filter object", () => {
  assert.equal(
    buildQuery({ status: ["captured", "voided"] }),
    "?status=captured&status=voided",
  );
});

test("buildQuery drops empty values so an unset filter sends no param", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ from: undefined, to: null, search: "" }), "");
  assert.equal(buildQuery({ status: [] }), "");
  // A zero is a real value, not an empty one.
  assert.equal(buildQuery({ limit: 0 }), "?limit=0");
});

test("buildQuery percent-encodes values", () => {
  assert.equal(buildQuery({ search: "a b&c=d" }), "?search=a+b%26c%3Dd");
});

test("buildQuery keeps a cursor byte-exact", () => {
  // Cursors are base64url; a mangled one silently restarts or skips a page.
  const cursor = "MjAyNi0wOS0xMlQwMDowMDowMC4wMDBafGFiYw";
  assert.equal(buildQuery({ cursor }), `?cursor=${cursor}`);
});

// FH: covers negatives too
test("bhd formats integer fils via @filspay/money, never float arithmetic", () => {
  assert.equal(bhd(0), "0.000 BHD");
  assert.equal(bhd(1), "0.001 BHD");
  assert.equal(bhd(1000), "1.000 BHD");
  assert.equal(bhd(1234567), "1234.567 BHD");
});

test("bhd shows a negative amount instead of throwing", () => {
  // The reconciliation gap is signed; a throw here replaced the whole page
  // with the router's error screen.
  assert.equal(bhd(-34), "-0.034 BHD");
  assert.equal(bhd(-23456), "-23.456 BHD");
});

test("parseRefundAmount turns a 3-decimal BHD entry into integer fils", () => {
  assert.equal(parseRefundAmount("4.75"), 4750);
  assert.equal(parseRefundAmount(" 4.755 "), 4755);
  assert.equal(parseRefundAmount("5"), 5000);
  // Blank means "refund everything still refundable".
  assert.equal(parseRefundAmount(""), undefined);
});

test("parseRefundAmount rejects zero, negatives and a 4th decimal", () => {
  assert.throws(() => parseRefundAmount("0"));
  assert.throws(() => parseRefundAmount("-1"));
  assert.throws(() => parseRefundAmount("1.2345"));
  assert.throws(() => parseRefundAmount("abc"));
});

test("parseBhdAmount reads BHD text as exact integer fils", () => {
  assert.equal(parseBhdAmount("0.5"), 500);
  assert.equal(parseBhdAmount("12"), 12000);
  assert.equal(parseBhdAmount("1.250"), 1250);
  assert.equal(parseBhdAmount(" 0.001 "), 1);
  assert.equal(parseBhdAmount("4.35"), 4350);
});

test("parseBhdAmount rejects blank, zero, negatives, a 4th decimal and non-numbers", () => {
  for (const bad of ["", "  ", "0", "0.000", "-1", "1.2345", "abc", "1e3", "1,5"]) {
    assert.throws(() => parseBhdAmount(bad), RangeError, bad);
  }
});

test("refundedFilsFromEvents sums refund events and ignores the rest", () => {
  const ev = (eventType: string, amountFils: number | null): TransactionEventDto => ({
    id: eventType + String(amountFils),
    transactionId: "t",
    eventType,
    amountFils,
    actorType: "merchant_user",
    actorId: null,
    metadata: {},
    occurredAt: "2026-10-30T00:00:00.000Z",
    createdAt: "2026-10-30T00:00:00.000Z",
  });
  assert.equal(
    refundedFilsFromEvents([ev("captured", 5000), ev("refund_partial", -1500), ev("refunded", -500), ev("voided", null)]),
    2000,
  );
  assert.equal(refundedFilsFromEvents([]), 0);
});

test("dash renders absent values as an em dash but keeps zero", () => {
  assert.equal(dash(null), "—");
  assert.equal(dash(undefined), "—");
  assert.equal(dash(""), "—");
  assert.equal(dash(0), "0");
});

test("dayStartIso converts a date input to the Asia/Bahrain day boundary", () => {
  // ADR-0003's business day: 12 Sep starts at Bahrain midnight, 21:00Z on 11 Sep.
  assert.equal(dayStartIso("2026-09-12"), "2026-09-11T21:00:00.000Z");
  assert.equal(dayStartIso(""), undefined);
});

test("localDateTimeToIso rejects garbage instead of sending Invalid Date", () => {
  assert.equal(localDateTimeToIso(""), null);
  assert.equal(localDateTimeToIso("not-a-date"), null);
  // A real value round-trips to the same instant it names.
  const iso = localDateTimeToIso("2026-09-12T14:30");
  assert.notEqual(iso, null);
  assert.equal(new Date(iso ?? "").getTime(), new Date("2026-09-12T14:30").getTime());
});

test("statusLabel turns a raw status or reason code into readable text", () => {
  assert.equal(statusLabel("captured"), "Captured");
  assert.equal(statusLabel("partially_captured"), "Partially captured");
  assert.equal(statusLabel("refund_partial"), "Refund partial");
  assert.equal(statusLabel("dispute_resolution"), "Dispute resolution");
  assert.equal(statusLabel(null), "");
  assert.equal(statusLabel(undefined), "");
  assert.equal(statusLabel(""), "");
});

test("actorLabel names the actor instead of showing a raw id", () => {
  assert.equal(actorLabel("merchant_session"), "Dashboard user");
  assert.equal(actorLabel("merchant_api_key"), "API key");
  assert.equal(actorLabel("system"), "System");
  assert.equal(actorLabel("admin_impersonation"), "Admin impersonation");
});
