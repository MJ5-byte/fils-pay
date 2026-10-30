/**
 * Route-level tests for merchant login (POST /v1/auth/login, then
 * POST /v1/auth/otp/verify) using `app.inject(...)` against `buildApp()` and
 * a real, migrated Postgres. Requires `DATABASE_URL` (run `npm run migrate`
 * first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "auth.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function createMerchantWithOwner(label: string, email: string, password: string): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Auth ${label} ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')`,
    [merchantId, email, await hashPassword(password, config)],
  );
  return merchantId;
}

test("login with one email in two merchants lands in the merchant whose password was checked", async () => {
  const email = `shared-${randomUUID()}@auth.test`;
  const merchantA = await createMerchantWithOwner("A", email, "password-for-a");
  const merchantB = await createMerchantWithOwner("B", email, "password-for-b");

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: merchantB, email, password: "password-for-b" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((c) => c.name === config.cookieName);
  assert.ok(cookie, "login must set the pending session cookie");

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookie.value },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.notEqual(verify.json().merchantId, merchantA, "must not land in the other merchant with the same email");
  assert.equal(verify.json().merchantId, merchantB);
});

test("wrong OTP codes count across logins, so re-logging in does not reset the guess budget", async () => {
  const email = `otp-limit-${randomUUID()}@auth.test`;
  const merchantId = await createMerchantWithOwner("otp-limit", email, "password-otp-limit");
  const login = () =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: "password-otp-limit" } });
  const verify = (cookie: string, code: string) =>
    app.inject({ method: "POST", url: "/v1/auth/otp/verify", cookies: { [config.cookieName]: cookie }, payload: { code } });

  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const res = await login();
    assert.equal(res.statusCode, 200, res.body);
    const cookie = res.cookies.find((c) => c.name === config.cookieName);
    assert.ok(cookie);
    rounds.push({ cookie: cookie.value, code: res.json().devOtpCode as string });
  }

  // Two rounds of five wrong codes each: ten failures across two challenges.
  for (const round of rounds.slice(0, 2)) {
    const wrong = round.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      assert.equal((await verify(round.cookie, wrong)).statusCode, 401);
    }
  }

  const third = rounds[2];
  assert.ok(third);
  const lockedVerify = await verify(third.cookie, third.code);
  assert.equal(lockedVerify.statusCode, 429, "a third challenge must not open a fresh guess budget");
  assert.equal(lockedVerify.json().error, "too_many_attempts");

  const lockedLogin = await login();
  assert.equal(lockedLogin.statusCode, 429, "a new login must not issue a fresh challenge after the limit");
  assert.equal(lockedLogin.json().error, "too_many_attempts");
});

test("parallel wrong OTP codes cannot get past the failure limit", async () => {
  const email = `otp-race-${randomUUID()}@auth.test`;
  const merchantId = await createMerchantWithOwner("otp-race", email, "password-otp-race");
  const cookies: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { merchantId, email, password: "password-otp-race" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const cookie = res.cookies.find((c) => c.name === config.cookieName);
    assert.ok(cookie);
    cookies.push(cookie.value);
  }

  // A real code is 6 digits, so "abc" never matches; 10 per pending session, all at once.
  const results = await Promise.all(
    cookies.flatMap((cookie) =>
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/auth/otp/verify",
          cookies: { [config.cookieName]: cookie },
          payload: { code: "abc" },
        }),
      ),
    ),
  );
  const statuses = results.map((r) => r.statusCode);
  assert.equal(statuses.filter((s) => s === 401).length, 10, `statuses: ${statuses.join(",")}`);
  assert.equal(statuses.filter((s) => s === 429).length, 30, `statuses: ${statuses.join(",")}`);

  const failures = await pool.query<{ n: number }>(
    `SELECT SUM(c.attempt_count)::int AS n FROM otp_challenges c
       JOIN merchant_users mu ON mu.id = c.merchant_user_id WHERE mu.merchant_id = $1`,
    [merchantId],
  );
  assert.equal(failures.rows[0]?.n, 10);
});

test("a resend racing wrong OTP verifies never deadlocks into a 500", async () => {
  const email = `otp-resend-race-${randomUUID()}@auth.test`;
  const merchantId = await createMerchantWithOwner("otp-resend-race", email, "password-otp-resend-race");
  const statuses: number[] = [];
  for (let round = 0; round < 15; round++) {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { merchantId, email, password: "password-otp-resend-race" },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.find((c) => c.name === config.cookieName);
    assert.ok(cookie);
    // Age every challenge past the resend throttle and out of the failure window, so each round
    // races a real resend against verifies that still record their failures.
    await pool.query(
      `UPDATE otp_challenges SET created_at = now() - interval '20 minutes'
        WHERE merchant_user_id = (SELECT id FROM merchant_users WHERE merchant_id = $1)`,
      [merchantId],
    );
    const cookies = { [config.cookieName]: cookie.value };
    const results = await Promise.all([
      app.inject({ method: "POST", url: "/v1/auth/otp/resend", cookies }),
      ...Array.from({ length: 4 }, () =>
        app.inject({ method: "POST", url: "/v1/auth/otp/verify", cookies, payload: { code: "abc" } }),
      ),
    ]);
    statuses.push(...results.map((r) => r.statusCode));
  }
  assert.equal(statuses.filter((s) => s >= 500).length, 0, `statuses: ${statuses.join(",")}`);
});

test("otp verify re-issues the session cookie at the full session TTL, not the pending one", async () => {
  const email = `otp-cookie-${randomUUID()}@auth.test`;
  const merchantId = await createMerchantWithOwner("otp-cookie", email, "password-otp-cookie");
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: "password-otp-cookie" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const pending = login.cookies.find((c) => c.name === config.cookieName);
  assert.ok(pending);
  assert.equal(pending.maxAge, config.pendingSessionTtlMinutes * 60);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: pending.value },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const full = verify.cookies.find((c) => c.name === config.cookieName);
  assert.ok(full, "verify must re-set the session cookie");
  assert.equal(full.value, pending.value);
  assert.equal(full.maxAge, config.sessionTtlHours * 3_600);
});
