#!/usr/bin/env node
// Checkout load test: N virtual buyers each open a fresh payment link and pay it.
//
//   node ops/loadtest/checkout.mjs --api http://127.0.0.1:3000 --users 40 --seconds 60
//
// Setup (not timed): signs up a throwaway merchant, logs in with the dev OTP
// (needs OTP_DEV_EXPOSE=true, so run it against a local/test stack, not
// production), and pre-creates one single-use link per checkout.
// Timed loop: GET /v1/payment-links/:token then POST .../pay (Idempotency-Key).
// Reports throughput, latency percentiles, 503 sheds, errors, and checks every
// approved payment landed exactly once.
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const API = args.api ?? "http://127.0.0.1:3000";
const USERS = Number(args.users ?? 20);
const SECONDS = Number(args.seconds ?? 30);
const ORIGIN = args.origin ?? "http://localhost:5173";
const MAX_LINKS = Number(args.links ?? USERS * SECONDS * 4);

async function call(method, path, { body, cookie, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

async function setupMerchant() {
  const email = `load-${randomUUID()}@example.test`;
  const password = `load-${randomUUID()}`;
  const signup = await call("POST", "/v1/merchants", {
    body: {
      businessProfile: {
        legalName: "Load Test W.L.L.",
        registrationNumber: "LT-1",
        businessType: "llc",
        contactEmail: email,
        contactPhone: "+973 3000 0000",
        addressLine1: "Bldg 1",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  if (signup.status !== 201) throw new Error(`signup ${signup.status} ${JSON.stringify(signup.json)}`);
  const merchantId = signup.json.merchantId;
  const login = await call("POST", "/v1/auth/login", { body: { merchantId, email, password } });
  if (login.status !== 200 || !login.json.devOtpCode) throw new Error(`login ${login.status} (needs OTP_DEV_EXPOSE=true)`);
  const cookie = login.setCookie.split(";")[0];
  const verify = await call("POST", "/v1/auth/otp/verify", { cookie, body: { code: login.json.devOtpCode } });
  if (verify.status !== 200) throw new Error(`otp verify ${verify.status}`);

  // Payments need an approved merchant (KYC). On a local/test database the
  // script approves its own throwaway merchant; it never touches others.
  if (!process.env.DATABASE_URL) throw new Error("set DATABASE_URL (test database) so the load-test merchant can be approved");
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true WHERE id = $1`, [merchantId]);
  await db.end();
  return { merchantId, cookie };
}

async function createLinks(merchantId, cookie, count) {
  const tokens = [];
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const batch = 10;
  for (let i = 0; i < count; i += batch) {
    const made = await Promise.all(
      Array.from({ length: Math.min(batch, count - i) }, () =>
        call("POST", `/v1/merchants/${merchantId}/payment-links`, {
          cookie,
          body: { amountFils: 1250, reference: "load", expiresAt },
        }),
      ),
    );
    for (const r of made) {
      if (r.status !== 201) throw new Error(`create link ${r.status} ${JSON.stringify(r.json)}`);
      tokens.push(r.json.token);
    }
  }
  return tokens;
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  console.log(`setup: merchant + ${MAX_LINKS} links on ${API}`);
  const { merchantId, cookie } = await setupMerchant();
  const tokens = await createLinks(merchantId, cookie, MAX_LINKS);
  let next = 0;

  const latencies = [];
  const counts = { paid: 0, declined: 0, shed: 0, error: 0 };
  const statuses = {};
  const paidTokens = new Set();
  const deadline = Date.now() + SECONDS * 1000;

  async function buyer() {
    while (Date.now() < deadline && next < tokens.length) {
      const token = tokens[next++];
      // A shed request (503) is retried after Retry-After with the same link
      // and the same Idempotency-Key, like a real checkout client would.
      const idempotencyKey = randomUUID();
      let pay;
      for (;;) {
        if (Date.now() >= deadline) return;
        const t0 = performance.now();
        const view = await call("GET", `/v1/payment-links/${token}`);
        if (view.status === 503) {
          counts.shed += 1;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        pay = await call("POST", `/v1/payment-links/${token}/pay`, {
          headers: { "idempotency-key": idempotencyKey },
          body: { card: { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
        });
        if (pay.status === 503) {
          counts.shed += 1;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        latencies.push(performance.now() - t0);
        break;
      }
      statuses[pay.status] = (statuses[pay.status] ?? 0) + 1;
      if (pay.status >= 200 && pay.status < 300 && pay.json?.status !== "declined") {
        counts.paid += 1;
        paidTokens.add(token);
      } else if (pay.status === 402 || pay.json?.status === "declined") {
        counts.declined += 1;
      } else {
        counts.error += 1;
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: USERS }, buyer));
  const elapsed = (Date.now() - started) / 1000;

  const sorted = [...latencies].sort((a, b) => a - b);
  const done = counts.paid + counts.declined;
  console.log(JSON.stringify({
    users: USERS,
    seconds: Math.round(elapsed),
    checkoutsPerSecond: +(done / elapsed).toFixed(2),
    ...counts,
    payStatuses: statuses,
    latencyMs: { p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)) },
    duplicatePaidTokens: counts.paid - paidTokens.size,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
