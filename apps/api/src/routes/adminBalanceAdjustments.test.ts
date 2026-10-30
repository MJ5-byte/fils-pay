/**
 * Route-level tests for the admin "Adjust balance" tool, via
 * `app.inject(...)` against a real, migrated Postgres (run `npm run migrate`
 * first). No test doubles — this route crosses no process boundary.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminBalanceAdjustments.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type AdminRole = "support" | "finance" | "super_admin";

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedAdminPasswordHash: string | null = null;

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) {
      return header.split(";")[0] as string;
    }
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: AdminRole): Promise<{ id: string; cookie: string }> {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `bal-adj-route-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `Test ${role}`, role],
  );

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { devOtpCode?: string };
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return { id: inserted.rows[0]!.id, cookie };
}

async function createMerchant(withBalanceFils: number | null): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`Bal Adj Route ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  if (withBalanceFils !== null) {
    await pool.query(
      `INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, $2)`,
      [merchantId, withBalanceFils],
    );
  }
  return merchantId;
}

const PATH = (merchantId: string) => `/v1/admin/merchants/${merchantId}/balance-adjustments`;

/** Before/after are the unchanged cache; the correction posts to the ledger for the next close. */
test("a valid adjustment returns 200 with the correct before/after", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(100_000);

  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 50_000, reason: "statement shows 50.000 BD higher" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    merchantId,
    deltaFils: 50_000,
    cachedPayableFilsBefore: 100_000,
    cachedPayableFilsAfter: 100_000,
  });

  const after = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(after.rows[0]!.cached_payable_fils), 100_000);
  const groups = await pool.query<{ net: string; payable: string }>(
    `SELECT SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'credit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(Number(groups.rows[0]!.net), 0);
  assert.equal(Number(groups.rows[0]!.payable), 50_000);
});

test("a negative adjustment is accepted", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(100_000);

  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: -25_000, reason: "duplicate credit backed out" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { cachedPayableFilsAfter: number }).cachedPayableFilsAfter, 100_000);
  const groups = await pool.query<{ net: string; payable: string }>(
    `SELECT SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'debit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(Number(groups.rows[0]!.net), 0);
  assert.equal(Number(groups.rows[0]!.payable), 25_000);
});

test("an unauthenticated request is a 401", async () => {
  const merchantId = await createMerchant(1_000);
  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    payload: { deltaFils: 100, reason: "no session" },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test("a support admin is a 403", async () => {
  const admin = await signedInAdmin("support");
  const merchantId = await createMerchant(1_000);
  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 100, reason: "wrong role" },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("a super_admin is allowed", async () => {
  const admin = await signedInAdmin("super_admin");
  const merchantId = await createMerchant(1_000);
  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 100, reason: "super admin" },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test("a non-UUID merchant id is a 404", async () => {
  const admin = await signedInAdmin("finance");
  const res = await app.inject({
    method: "POST",
    url: PATH("not-a-uuid"),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 100, reason: "bad id" },
  });
  assert.equal(res.statusCode, 404, res.body);
});

// FH: Claude suggests auto-creating the row instead. no — MK
test("a merchant with no merchant_balances row yet is accepted", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(null);

  const res = await app.inject({
    method: "POST",
    url: PATH(merchantId),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 100, reason: "nothing to adjust" },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test("an unknown but UUID-shaped merchant is a 404", async () => {
  const admin = await signedInAdmin("finance");
  const res = await app.inject({
    method: "POST",
    url: PATH(randomUUID()),
    headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
    payload: { deltaFils: 100, reason: "no such merchant" },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test("an integer beyond the safe range is a 400, not a 500", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(1_000);

  // Raw JSON text: a JS object literal would already have rounded the value.
  for (const raw of ["9007199254740993", "-9007199254740993"]) {
    const res = await app.inject({
      method: "POST",
      url: PATH(merchantId),
      headers: { cookie: admin.cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: `{"deltaFils":${raw},"reason":"too large"}`,
    });
    assert.equal(res.statusCode, 400, `${raw} -> ${res.body}`);
    assert.equal((res.json() as { error: string }).error, "invalid_request");
  }
});

test("invalid bodies are rejected with 400", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(1_000);

  for (const payload of [
    {},
    { deltaFils: 100 },
    { reason: "no delta" },
    { deltaFils: 0, reason: "zero is not a correction" },
    { deltaFils: 1.5, reason: "fils are integers" },
    { deltaFils: "100", reason: "wrong type" },
    { deltaFils: 100, reason: "   " },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: PATH(merchantId),
      headers: { cookie: admin.cookie, "idempotency-key": randomUUID() },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }
});

test("a resent adjustment with the same Idempotency-Key moves the balance once", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant(100_000);
  const send = () =>
    app.inject({
      method: "POST",
      url: PATH(merchantId),
      headers: { cookie: admin.cookie, "idempotency-key": "resend-after-timeout" },
      payload: { deltaFils: 5_000, reason: "statement correction" },
    });

  const first = await send();
  const second = await send();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());

  const after = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(after.rows[0]?.cached_payable_fils), 100_000);
  const groups = await pool.query<{ n: string; net: string; payable: string }>(
    `SELECT COUNT(*)::text AS n,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'credit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(groups.rows[0]!.n, "2");
  assert.equal(Number(groups.rows[0]!.net), 0);
  assert.equal(Number(groups.rows[0]!.payable), 5_000);
});
