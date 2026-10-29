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
