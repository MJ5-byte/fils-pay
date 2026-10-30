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

test("in production the login code is in the response only for an allowlisted email domain", async () => {
  const demoDomain = `demo-${randomUUID().slice(0, 8)}.example`;
  const prodConfig = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    OTP_DEV_EXPOSE: "false",
    OTP_EXPOSE_EMAIL_DOMAINS: ` other.example, ${demoDomain.toUpperCase()} `,
    SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "test-acquirer-secret",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    CARD_FINGERPRINT_KEY: "dGVzdC1jYXJkLWZpbmdlcnByaW50LWtleS0zMi1ieXQ=",
  });
  const prodApp = buildApp(prodConfig, pool);
  try {
    const demoEmail = `owner-${randomUUID()}@${demoDomain}`;
    const demoMerchant = await createMerchantWithOwner("demo-domain", demoEmail, "password-demo");
    const demoLogin = await prodApp.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { merchantId: demoMerchant, email: demoEmail, password: "password-demo" },
    });
    assert.equal(demoLogin.statusCode, 200, demoLogin.body);
    assert.match(String(demoLogin.json().devOtpCode), /^\d+$/, "an allowlisted domain must see its code");

    // Same domain as a subdomain suffix must not match: only the exact part after the last @ counts.
    const realEmail = `owner-${randomUUID()}@mail.${demoDomain}`;
    const realMerchant = await createMerchantWithOwner("real-domain", realEmail, "password-real");
    const realLogin = await prodApp.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { merchantId: realMerchant, email: realEmail, password: "password-real" },
    });
    assert.equal(realLogin.statusCode, 200, realLogin.body);
    assert.equal(realLogin.json().devOtpCode, undefined, "any other domain must never get the code");
  } finally {
    await prodApp.close();
  }
});

test("five wrong passwords lock one account's login for a cooldown, and a correct login before that clears the count", async () => {
  const emailA = `password-limit-a-${randomUUID()}@auth.test`;
  const password = "password-login-limit";
  const merchantA = await createMerchantWithOwner("password-limit-a", emailA, password);
  const login = (merchantId: string, email: string, suppliedPassword: string) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: suppliedPassword } });

  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 4; i++) {
      const wrong = await login(merchantA, emailA, "wrong-password");
      assert.equal(wrong.statusCode, 401, "wrong passwords below the limit must return invalid credentials");
    }
    const correct = await login(merchantA, emailA, password);
    assert.equal(correct.statusCode, 200, "a correct password before the limit must clear previous failures");
  }

  for (let i = 0; i < 5; i++) {
    const wrong = await login(merchantA, emailA, "wrong-password");
    assert.equal(wrong.statusCode, 401, "the first five wrong passwords must return invalid credentials");
  }
  const locked = await login(merchantA, emailA, password);
  assert.equal(locked.statusCode, 429, "even the right password must be refused while locked");
  assert.equal(locked.json().error, "too_many_login_attempts", "password lockout must use its own error code");
  const uppercaseLocked = await login(merchantA.toUpperCase(), emailA, password);
  assert.equal(uppercaseLocked.statusCode, 429, "changing the merchant id's case must not bypass the lockout");
  assert.equal(uppercaseLocked.json().error, "too_many_login_attempts", "UUID case variants must share the lockout code");
  const retryAfter = Number(locked.headers["retry-after"]);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900, "lockout must retain a Retry-After of 1 to 900 seconds");

  const emailB = `password-limit-b-${randomUUID()}@auth.test`;
  const merchantB = await createMerchantWithOwner("password-limit-b", emailB, password);
  const other = await login(merchantB, emailB, password);
  assert.equal(other.statusCode, 200, "a different account must be unaffected by the lockout");

  const unknownMerchant = randomUUID();
  const unknownEmail = `password-limit-unknown-${randomUUID()}@auth.test`;
  for (let i = 0; i < 5; i++) {
    const wrong = await login(unknownMerchant, unknownEmail, "wrong-password");
    assert.equal(wrong.statusCode, 401, "unknown accounts must have the same initial failure responses");
  }
  const unknownLocked = await login(unknownMerchant, unknownEmail, "wrong-password");
  assert.equal(unknownLocked.statusCode, 429, "unknown accounts must have the same lockout threshold");
  assert.equal(unknownLocked.json().error, "too_many_login_attempts", "unknown accounts must have the same lockout code");
  const unknownRetryAfter = Number(unknownLocked.headers["retry-after"]);
  assert.ok(Number.isInteger(unknownRetryAfter) && unknownRetryAfter >= 1 && unknownRetryAfter <= 900, "unknown accounts must retain the same Retry-After range");

  const longEmail = `${Array.from({ length: 128 }, () => randomUUID()).join("")}@auth.test`;
  const longUnknown = await login(randomUUID(), longEmail, "wrong-password");
  assert.equal(longUnknown.statusCode, 401, "a long unknown email must return invalid credentials without an index error");
});

test("eight simultaneous correct logins to one account all succeed, and parallel wrong passwords still lock", async () => {
  const email = `password-burst-${randomUUID()}@auth.test`;
  const password = "password-login-burst";
  const merchantId = await createMerchantWithOwner("password-burst", email, password);
  const login = (suppliedPassword: string) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: suppliedPassword } });

  const correct = await Promise.all(Array.from({ length: 8 }, () => login(password)));
  assert.deepEqual(correct.map((r) => r.statusCode), Array(8).fill(200), "in-flight correct logins must not count as failures");

  const wrong = await Promise.all(Array.from({ length: 6 }, () => login("wrong-password")));
  const statuses = wrong.map((r) => r.statusCode).sort();
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], `parallel guesses must stay capped at five: ${statuses.join(",")}`);
  const locked = await login(password);
  assert.equal(locked.statusCode, 429, "the right password must still be refused once five wrong guesses landed");
  assert.equal(locked.json().error, "too_many_login_attempts", "the burst lockout must use the password lockout code");
});

test("login with an array merchantId is rejected as invalid_request, not a 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: [randomUUID()], email: "array@auth.test", password: "x" },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_request");
});

test("otp verify with an object code is rejected as invalid_request, not a 500", async () => {
  const email = `object-code-${randomUUID()}@auth.test`;
  const merchantId = await createMerchantWithOwner("object-code", email, "password");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: "password" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies.find((c) => c.name === config.cookieName)!;

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [config.cookieName]: cookie.value },
    payload: { code: { toString: 1 } },
  });
  assert.equal(verify.statusCode, 400, verify.body);
  assert.equal(verify.json().error, "invalid_request");
});
