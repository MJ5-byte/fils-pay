/**
 * Route-level tests for the admin plane, via `app.inject(...)`
 * against a real, migrated Postgres — no mocking of the DB layer. Requires
 * DATABASE_URL to point at one (run `npm run migrate` first).
 *
 * The only test double anywhere in here is for the two calls that cross the
 * process boundary into apps/settlement. Those are injected through
 * `buildApp`'s `admin.settlement` seam so this file can prove the *route's*
 * own logic — the before/after audit pattern, the success path, the failure
 * path — without a live Go process. `settlementClient.test.ts` covers the
 * real fetch-based client separately, against real local HTTP servers.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { createWebhookEndpoint } from "../webhooks/create.js";
import type { AdminRoutesOptions } from "./admin.js";
import type {
  MdrRecalcSummary,
  RebuildSummary,
  RunBatchSummary,
} from "../admin/settlementClient.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "admin.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_ALLOW_PRIVATE_TARGETS: "true",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

/** Records what the injected settlement calls were asked to do, and lets an
 *  individual test decide how they behave. */
interface SettlementSpy {
  runBatchCalls: Array<{ date: string; merchantId?: string }>;
  rebuildCalls: number;
  recalcMdrCalls: Array<{ merchantId: string; from: string; to: string }>;
  runBatchImpl: (input: { date: string; merchantId?: string }) => Promise<RunBatchSummary>;
  rebuildImpl: () => Promise<RebuildSummary>;
  recalcMdrImpl: (input: { merchantId: string; from: string; to: string }) => Promise<MdrRecalcSummary>;
}

const settlementSpy: SettlementSpy = {
  runBatchCalls: [],
  rebuildCalls: 0,
  recalcMdrCalls: [],
  runBatchImpl: async () => ({ businessDate: "2026-09-09", merchantResults: [] }),
  rebuildImpl: async () => ({ rebuiltCount: 0, changed: [] }),
  recalcMdrImpl: async () => ({ batchesConsidered: 0, adjusted: [] }),
};

const adminOptions: AdminRoutesOptions = {
  settlement: {
    runBatch: async (_cfg, input) => {
      settlementSpy.runBatchCalls.push(input);
      return settlementSpy.runBatchImpl(input);
    },
    rebuildBalances: async () => {
      settlementSpy.rebuildCalls += 1;
      return settlementSpy.rebuildImpl();
    },
    recalculateMdr: async (_cfg, input) => {
      settlementSpy.recalcMdrCalls.push(input);
      return settlementSpy.recalcMdrImpl(input);
    },
  },
};

const app = buildApp(config, pool, { admin: adminOptions });

test.after(async () => {
  await app.close();
  await pool.end();
});

// ---------------------------------------------------------------- helpers

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) {
      return header.split(";")[0] as string;
    }
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

type AdminRole = "support" | "finance" | "super_admin";

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedAdminPasswordHash: string | null = null;

async function createAdminUser(role: AdminRole, label: string): Promise<{ id: string; email: string }> {
  // argon2 is intentionally expensive; hash the one fixed test password once
  // and reuse the encoded hash across fixtures.
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `${label}-${randomUUID()}@admin.test`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `Test ${role}`, role],
  );
  return { id: result.rows[0]!.id, email };
}

/** Full admin login: password -> OTP -> authenticated cookie. */
async function loginAdmin(email: string): Promise<string> {
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { otpRequired: boolean; devOtpCode?: string };
  assert.equal(loginBody.otpRequired, true);
  assert.ok(loginBody.devOtpCode);
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return cookie;
}

async function signedInAdmin(role: AdminRole, label: string) {
  const user = await createAdminUser(role, label);
  const cookie = await loginAdmin(user.email);
  return { ...user, cookie };
}

async function createMerchant(label: string): Promise<{ merchantId: string; ownerUserId: string }> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Admin Test ${label} ${randomUUID()}`, 250],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  return { merchantId, ownerUserId: userResult.rows[0]!.id };
}

async function auditRowsFor(adminUserId: string, action: string) {
  const result = await pool.query<{
    id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    metadata: Record<string, unknown>;
    outcome: string;
  }>(
    `SELECT id, action, target_type, target_id, metadata, outcome
       FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at`,
    [adminUserId, action],
  );
  return result.rows;
}

// ------------------------------------------------------------ admin auth

test("admin login -> otp verify -> GET /v1/admin/auth/me, then logout kills the cookie", async () => {
  const { id, email } = await createAdminUser("finance", "meflow");
  const cookie = await loginAdmin(email);

  const meRes = await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 200, meRes.body);
  assert.deepEqual(meRes.json(), { adminUserId: id, email, role: "finance" });

  const logoutRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/logout",
    headers: { cookie },
  });
  assert.equal(logoutRes.statusCode, 204);

  const afterRes = await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie } });
  assert.equal(afterRes.statusCode, 401);
});

// the merchant side has the same test in app.test.ts — FH
// MK: does it? i only see signup -> login -> otp verify there
test("a pending (pre-OTP) admin cookie authenticates nothing", async () => {
  const { email } = await createAdminUser("super_admin", "pending");
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);

  const meRes = await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 401, "authenticated=false must never satisfy requireAdminSession");
});

test("admin login failures are generic and never disclose which part was wrong", async () => {
  const { email } = await createAdminUser("support", "badpw");

  const wrongPassword = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: "not-the-password" },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(wrongPassword.json().error, "invalid_credentials");

  const noSuchUser = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email: `ghost-${randomUUID()}@admin.test`, password: ADMIN_PASSWORD },
  });
  assert.equal(noSuchUser.statusCode, 401);
  assert.equal(noSuchUser.json().error, "invalid_credentials");
});

/** Sessions die; impersonation grants issued by that admin are a separate cookie and are not covered here. */
test("a disabled admin cannot log in, and an existing session dies immediately", async () => {
  const { id, email } = await createAdminUser("finance", "disabled");
  const cookie = await loginAdmin(email);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie } })).statusCode, 200);

  await pool.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [id]);

  const meRes = await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 401, "status='active' is part of the session predicate, not a login-time check");

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 401);
});

test("admin otp verify rejects a wrong code without burning the challenge", async () => {
  const { email } = await createAdminUser("support", "wrongotp");
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);
  const realCode = (loginRes.json() as { devOtpCode: string }).devOtpCode;
  const wrongCode = realCode === "000000" ? "111111" : "000000";

  const wrongRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: wrongCode },
  });
  assert.equal(wrongRes.statusCode, 401);
  assert.equal(wrongRes.json().error, "invalid_code");

  const rightRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: realCode },
  });
  assert.equal(rightRes.statusCode, 200, rightRes.body);
});

test("a merchant session cookie grants nothing on the admin plane", async () => {
  // fp_sid and fp_admin_sid are separate names backed by separate tables;
  // presenting one where the other is expected must resolve to nothing.
  const { merchantId } = await createMerchant("crosscookie");
  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/merchants",
    headers: { cookie: `${config.cookieName}=${randomUUID()}` },
  });
  assert.equal(res.statusCode, 401);
  assert.ok(merchantId);
});

// ------------------------------------------------------- role gating

test("requireAdminRole: a support admin is 403'd on every finance-gated route", async () => {
  const support = await signedInAdmin("support", "rolegate");
  const { merchantId } = await createMerchant("rolegate");
  const issued = await issueApiKey(pool, config, {
    merchantId,
    createdBy: (await createMerchant("rolegate-owner")).ownerUserId,
    label: "unused",
  });

  const financeOnly: Array<{ url: string; payload: Record<string, unknown> }> = [
    { url: `/v1/admin/merchants/${merchantId}/kyc-reviews`, payload: { outcome: "approved" } },
    { url: `/v1/admin/merchants/${merchantId}/api-keys/${issued.id}/rotate`, payload: {} },
    { url: "/v1/admin/settlement/run-batch", payload: { date: "2026-09-09" } },
    { url: "/v1/admin/balances/rebuild", payload: {} },
  ];

  for (const route of financeOnly) {
    const res = await app.inject({
      method: "POST",
      url: route.url,
      headers: { cookie: support.cookie },
      payload: route.payload,
    });
    assert.equal(res.statusCode, 403, `${route.url} -> ${res.body}`);
    assert.equal(res.json().error, "forbidden");
  }

  // ...and nothing happened as a side effect of any of them.
  const reviews = await pool.query(`SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = $1`, [merchantId]);
  assert.equal(reviews.rowCount, 0);
  assert.equal(settlementSpy.runBatchCalls.length, 0);
  assert.equal(settlementSpy.rebuildCalls, 0);
  assert.equal((await auditRowsFor(support.id, "kyc_review")).length, 0);
});

test("requireAdminRole: a support admin CAN reach the any-role routes", async () => {
  const support = await signedInAdmin("support", "rolegate-allowed");
  const { merchantId } = await createMerchant("rolegate-allowed");

  const listRes = await app.inject({
    method: "GET",
    url: "/v1/admin/merchants",
    headers: { cookie: support.cookie },
  });
  assert.equal(listRes.statusCode, 200, listRes.body);

  const detailRes = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants/${merchantId}`,
    headers: { cookie: support.cookie },
  });
  assert.equal(detailRes.statusCode, 200, detailRes.body);

  const impersonateRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: support.cookie },
  });
  assert.equal(impersonateRes.statusCode, 201, impersonateRes.body);
});

test("every admin route rejects an unauthenticated caller", async () => {
  const { merchantId } = await createMerchant("noauth");
  const routes: Array<["GET" | "POST", string]> = [
    ["GET", "/v1/admin/merchants"],
    ["GET", `/v1/admin/merchants/${merchantId}`],
    ["POST", `/v1/admin/merchants/${merchantId}/kyc-reviews`],
    ["POST", "/v1/admin/merchants/bulk-approve"],
    ["POST", `/v1/admin/merchants/${merchantId}/api-keys/${randomUUID()}/rotate`],
    ["POST", `/v1/admin/merchants/${merchantId}/webhook-endpoints/${randomUUID()}/replay-batch`],
    ["POST", `/v1/admin/merchants/${merchantId}/impersonate`],
    ["POST", "/v1/admin/settlement/run-batch"],
    ["POST", "/v1/admin/balances/rebuild"],
    ["POST", `/v1/admin/impersonation/${randomUUID()}/end`],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url} -> ${res.body}`);
  }
});

// ------------------------------------------------------- KYC review

test("the OLD shared-secret KYC review route no longer exists at all", async () => {
  const { merchantId } = await createMerchant("oldkyc");

  // With a bearer token — the exact call that used to work.
  const withToken = await app.inject({
    method: "POST",
    url: "/v1/internal/kyc-reviews",
    headers: { authorization: "Bearer test-internal-token" },
    payload: { merchantId, outcome: "approved" },
  });
  assert.equal(withToken.statusCode, 404, "the route must be GONE, not merely guarded harder");

  const withoutToken = await app.inject({
    method: "POST",
    url: "/v1/internal/kyc-reviews",
    payload: { merchantId, outcome: "approved" },
  });
  assert.equal(withoutToken.statusCode, 404);

  const merchant = await pool.query<{ kyc_passed: boolean }>(
    `SELECT kyc_passed FROM merchants WHERE id = $1`,
    [merchantId],
  );
  assert.equal(merchant.rows[0]!.kyc_passed, false);
});

test("KYC review via the new admin guard writes both reviewer columns and exactly one audit row", async () => {
  const finance = await signedInAdmin("finance", "kyc");
  const { merchantId } = await createMerchant("kyc");

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    headers: { cookie: finance.cookie },
    payload: { outcome: "approved", notes: "docs check out" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { onboardingStatus: "approved", kycPassed: true });

  const review = await pool.query<{
    reviewer_identifier: string;
    reviewer_admin_user_id: string | null;
    notes: string | null;
  }>(
    `SELECT reviewer_identifier, reviewer_admin_user_id, notes FROM merchant_kyc_reviews WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(review.rowCount, 1);
  assert.equal(review.rows[0]!.reviewer_identifier, finance.email);
  assert.equal(review.rows[0]!.reviewer_admin_user_id, finance.id, "0036's real FK must be populated");
  assert.equal(review.rows[0]!.notes, "docs check out");

  const merchant = await pool.query<{ kyc_passed: boolean; onboarding_status: string }>(
    `SELECT kyc_passed, onboarding_status FROM merchants WHERE id = $1`,
    [merchantId],
  );
  assert.equal(merchant.rows[0]!.kyc_passed, true);
  assert.equal(merchant.rows[0]!.onboarding_status, "approved");

  const audit = await auditRowsFor(finance.id, "kyc_review");
  assert.equal(audit.length, 1, "exactly one audit row per action, never zero and never two");
  assert.equal(audit[0]!.target_type, "merchant");
  assert.equal(audit[0]!.target_id, merchantId);
  assert.equal(audit[0]!.outcome, "succeeded");
  assert.equal((audit[0]!.metadata as { outcome?: string }).outcome, "approved");
});

test("KYC review 404s on an unknown merchant and 400s on a bad outcome", async () => {
  const finance = await signedInAdmin("finance", "kycbad");

  const unknown = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${randomUUID()}/kyc-reviews`,
    headers: { cookie: finance.cookie },
    payload: { outcome: "approved" },
  });
  assert.equal(unknown.statusCode, 404);

  const { merchantId } = await createMerchant("kycbad");
  const badOutcome = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    headers: { cookie: finance.cookie },
    payload: { outcome: "maybe" },
  });
  assert.equal(badOutcome.statusCode, 400);
});

// ------------------------------------------------- bulk KYC approve

/** One audit row for the whole batch; per-merchant merchant_kyc_reviews rows are written as well. */
test("bulk approve KYC flips every selected pending merchant and writes one audit row", async () => {
  const finance = await signedInAdmin("finance", "bulkkyc");
  const first = await createMerchant("bulkkyc-a");
  const second = await createMerchant("bulkkyc-b");
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = ANY($1)`, [
    [first.merchantId, second.merchantId],
  ]);

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: finance.cookie },
    payload: { merchantIds: [first.merchantId, second.merchantId], notes: "queue ticket #4821" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { approvedCount: number; approvedMerchantIds: string[] };
  assert.equal(body.approvedCount, 2);
  assert.deepEqual(new Set(body.approvedMerchantIds), new Set([first.merchantId, second.merchantId]));

  const merchants = await pool.query<{ kyc_passed: boolean; onboarding_status: string }>(
    `SELECT kyc_passed, onboarding_status FROM merchants WHERE id = ANY($1)`,
    [[first.merchantId, second.merchantId]],
  );
  assert.equal(merchants.rowCount, 2);
  for (const row of merchants.rows) {
    assert.equal(row.kyc_passed, true);
    assert.equal(row.onboarding_status, "approved");
  }

  const audit = await auditRowsFor(finance.id, "kyc_bulk_approve");
  assert.equal(audit.length, 1, "one audit row for the whole batch, not one per merchant");
  assert.equal(audit[0]!.target_type, "platform");
  assert.equal(audit[0]!.target_id, null);
  assert.equal(audit[0]!.outcome, "succeeded");
  const metadata = audit[0]!.metadata as {
    requestedMerchantIds: string[];
    approvedMerchantIds: string[];
    notes: string | null;
  };
  assert.equal(metadata.requestedMerchantIds.length, 2);
  assert.equal(metadata.approvedMerchantIds.length, 2);
  assert.equal(metadata.notes, "queue ticket #4821");
});

test("bulk approve KYC is finance-gated and rejects malformed selections", async () => {
  const support = await signedInAdmin("support", "bulkkyc-role");
  const { merchantId } = await createMerchant("bulkkyc-role");

  const forbidden = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: support.cookie },
    payload: { merchantIds: [merchantId] },
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().error, "forbidden");
  const untouched = await pool.query<{ kyc_passed: boolean }>(
    `SELECT kyc_passed FROM merchants WHERE id = $1`,
    [merchantId],
  );
  assert.equal(untouched.rows[0]!.kyc_passed, false);
  assert.equal((await auditRowsFor(support.id, "kyc_bulk_approve")).length, 0);

  const finance = await signedInAdmin("finance", "bulkkyc-bad");
  const badPayloads: Array<Record<string, unknown>> = [
    {},
    { merchantIds: [] },
    { merchantIds: ["not-a-uuid"] },
    { merchantIds: [merchantId, "not-a-uuid"] },
    { merchantIds: Array.from({ length: 201 }, () => randomUUID()) },
  ];
  for (const payload of badPayloads) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/merchants/bulk-approve",
      headers: { cookie: finance.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 120));
    assert.equal(res.json().error, "invalid_request");
  }
  assert.equal((await auditRowsFor(finance.id, "kyc_bulk_approve")).length, 0);

  const stillUntouched = await pool.query<{ kyc_passed: boolean }>(
    `SELECT kyc_passed FROM merchants WHERE id = $1`,
    [merchantId],
  );
  assert.equal(stillUntouched.rows[0]!.kyc_passed, false);
});

test("a forced audit-write failure rolls the WHOLE bulk approval back", async () => {
  const finance = await signedInAdmin("finance", "bulkkyc-auditfail");
  const first = await createMerchant("bulkkyc-auditfail-a");
  const second = await createMerchant("bulkkyc-auditfail-b");
  // Only under_review merchants are approvable, so without this nothing would
  // change even if the rollback were broken.
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = ANY($1)`, [
    [first.merchantId, second.merchantId],
  ]);

  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_bulk_kyc_audit CHECK (action <> 'kyc_bulk_approve') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/merchants/bulk-approve",
      headers: { cookie: finance.cookie },
      payload: { merchantIds: [first.merchantId, second.merchantId] },
    });
    assert.equal(res.statusCode, 500, "an unwritable audit row must fail the request, never return 200");
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_bulk_kyc_audit`);
  }

  const merchants = await pool.query<{ kyc_passed: boolean; onboarding_status: string }>(
    `SELECT kyc_passed, onboarding_status FROM merchants WHERE id = ANY($1)`,
    [[first.merchantId, second.merchantId]],
  );
  assert.equal(merchants.rowCount, 2);
  for (const row of merchants.rows) {
    assert.equal(row.kyc_passed, false, "the batch approval must have rolled back for every merchant");
    assert.equal(row.onboarding_status, "under_review");
  }
  const reviews = await pool.query(`SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = ANY($1)`, [
    [first.merchantId, second.merchantId],
  ]);
  assert.equal(reviews.rowCount, 0, "the review rows must roll back with the approval");
  assert.equal((await auditRowsFor(finance.id, "kyc_bulk_approve")).length, 0);

  const retry = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: finance.cookie },
    payload: { merchantIds: [first.merchantId, second.merchantId] },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((retry.json() as { approvedCount: number }).approvedCount, 2);
});

// ------------------------------------------------------ audit atomicity

test("a forced audit-write failure rolls the WHOLE action back — the KYC review never happens", async () => {
  const finance = await signedInAdmin("finance", "auditfail");
  const { merchantId } = await createMerchant("auditfail");

  // Make the audit insert for this action fail, for real, at the database.
  // NOT VALID only skips re-checking pre-existing rows; new inserts are
  // still rejected.
  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_kyc_audit CHECK (action <> 'kyc_review') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
      headers: { cookie: finance.cookie },
      payload: { outcome: "approved" },
    });
    assert.equal(res.statusCode, 500, "an unwritable audit row must fail the request, never return 200");
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_kyc_audit`);
  }

  // The merchant-affecting writes that ran BEFORE the audit insert are gone.
  const merchant = await pool.query<{ kyc_passed: boolean; onboarding_status: string }>(
    `SELECT kyc_passed, onboarding_status FROM merchants WHERE id = $1`,
    [merchantId],
  );
  assert.equal(merchant.rows[0]!.kyc_passed, false, "merchants UPDATE must have rolled back");
  assert.equal(merchant.rows[0]!.onboarding_status, "submitted");
  const reviews = await pool.query(`SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = $1`, [merchantId]);
  assert.equal(reviews.rowCount, 0, "merchant_kyc_reviews INSERT must have rolled back");
  assert.equal((await auditRowsFor(finance.id, "kyc_review")).length, 0);

  // And the route works again once the audit table does.
  const retry = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    headers: { cookie: finance.cookie },
    payload: { outcome: "approved" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
});

test("a forced audit-write failure rolls back an API key rotation entirely", async () => {
  const finance = await signedInAdmin("finance", "auditfail-rotate");
  const { merchantId, ownerUserId } = await createMerchant("auditfail-rotate");
  const original = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "orig" });

  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_rotate_audit CHECK (action <> 'api_key_rotate') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/api-keys/${original.id}/rotate`,
      headers: { cookie: finance.cookie },
      payload: {},
    });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_rotate_audit`);
  }

  // Neither half of the rotation survived: the old key is NOT revoked (which
  // would have been the dangerous outcome) and no replacement exists.
  const keys = await pool.query<{ id: string; revoked_at: Date | null }>(
    `SELECT id, revoked_at FROM api_keys WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(keys.rowCount, 1);
  assert.equal(keys.rows[0]!.id, original.id);
  assert.equal(keys.rows[0]!.revoked_at, null, "a failed rotation must not leave a revoked key with no replacement");
});

// ------------------------------------------- merchant list/detail

test("GET /v1/admin/merchants lists across merchants, filters by status, and searches", async () => {
  const admin = await signedInAdmin("support", "list");
  const marker = randomUUID().slice(0, 8);
  const a = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, onboarding_status) VALUES ($1, 'approved') RETURNING id`,
    [`ListTest-${marker}-Alpha`],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, onboarding_status) VALUES ($1, 'rejected') RETURNING id`,
    [`ListTest-${marker}-Beta`],
  );

  const all = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants?q=ListTest-${marker}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(all.statusCode, 200, all.body);
  const allBody = all.json() as { merchants: Array<{ id: string; displayName: string }>; nextCursor: string | null };
  assert.equal(allBody.merchants.length, 2);

  const filtered = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants?q=ListTest-${marker}&onboardingStatus=approved`,
    headers: { cookie: admin.cookie },
  });
  const filteredBody = filtered.json() as { merchants: Array<{ id: string }> };
  assert.equal(filteredBody.merchants.length, 1);
  assert.equal(filteredBody.merchants[0]!.id, a.rows[0]!.id);

  // Exact-id search.
  const byId = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants?q=${b.rows[0]!.id}`,
    headers: { cookie: admin.cookie },
  });
  const byIdBody = byId.json() as { merchants: Array<{ id: string }> };
  assert.equal(byIdBody.merchants.length, 1);
  assert.equal(byIdBody.merchants[0]!.id, b.rows[0]!.id);

  // Keyset paging returns each row once, in order.
  const page1 = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants?q=ListTest-${marker}&limit=1`,
    headers: { cookie: admin.cookie },
  });
  const page1Body = page1.json() as { merchants: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(page1Body.merchants.length, 1);
  assert.ok(page1Body.nextCursor);
  const page2 = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants?q=ListTest-${marker}&limit=1&cursor=${page1Body.nextCursor}`,
    headers: { cookie: admin.cookie },
  });
  const page2Body = page2.json() as { merchants: Array<{ id: string }> };
  assert.equal(page2Body.merchants.length, 1);
  assert.notEqual(page2Body.merchants[0]!.id, page1Body.merchants[0]!.id);
});

test("GET /v1/admin/merchants/:id composes the detail view and never leaks a secret", async () => {
  const admin = await signedInAdmin("super_admin", "detail");
  const { merchantId, ownerUserId } = await createMerchant("detail");
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "detail key" });
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  const res = await app.inject({
    method: "GET",
    url: `/v1/admin/merchants/${merchantId}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    merchant: { id: string };
    apiKeys: Array<{ id: string }>;
    webhookEndpoints: Array<{ id: string }>;
    kycReviews: unknown[];
    balance: unknown;
    recentSettlementBatches: unknown[];
  };
  assert.equal(body.merchant.id, merchantId);
  assert.equal(body.apiKeys.length, 1);
  assert.equal(body.apiKeys[0]!.id, issued.id);
  assert.equal(body.webhookEndpoints.length, 1);
  assert.equal(body.webhookEndpoints[0]!.id, endpoint.id);

  const serialized = res.body;
  assert.equal(serialized.includes(issued.rawKey), false, "raw API key must never appear");
  assert.equal(serialized.includes(endpoint.secret), false, "webhook secret must never appear");
  assert.equal(serialized.includes("secretCiphertext"), false);
  assert.equal(serialized.includes("keyHash"), false);
});

test("GET /v1/admin/merchants/:id 404s for an unknown or malformed id", async () => {
  const admin = await signedInAdmin("support", "detail404");
  for (const id of [randomUUID(), "not-a-uuid"]) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/merchants/${id}`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(res.statusCode, 404, `${id} -> ${res.body}`);
  }
});

// -------------------------------------------------- API key rotation

test("API key rotation issues a new key and revokes the previous one atomically, and audits it", async () => {
  const finance = await signedInAdmin("finance", "rotate");
  const { merchantId, ownerUserId } = await createMerchant("rotate");
  const original = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "original" });

  // The old key works before the rotation.
  const before = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${original.rawKey}` },
  });
  assert.equal(before.statusCode, 200, before.body);

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/api-keys/${original.id}/rotate`,
    headers: { cookie: finance.cookie },
    payload: { label: "rotated by admin" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const rotated = res.json() as { id: string; prefix: string; rawKey: string; previousKeyId: string };
  assert.equal(rotated.previousKeyId, original.id);
  assert.notEqual(rotated.id, original.id);
  assert.ok(rotated.rawKey.startsWith("fp_test_"));
  assert.equal(rotated.prefix, rotated.rawKey.slice(0, 16));

  // Rotation exists to retire a possibly leaked credential, so the old key
  // must stop working the moment the new one is issued.
  const after = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${original.rawKey}` },
  });
  assert.equal(after.statusCode, 401, "the previous key is refused after rotation");

  // The new key works too.
  const withNew = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rotated.rawKey}` },
  });
  assert.equal(withNew.statusCode, 200, withNew.body);

  const rows = await pool.query<{
    id: string;
    revoked_at: Date | null;
    revoked_reason: string | null;
    created_by: string | null;
    created_by_admin_user_id: string | null;
    rotated_from_key_id: string | null;
    label: string | null;
  }>(
    `SELECT id, revoked_at, revoked_reason, created_by, created_by_admin_user_id, rotated_from_key_id, label
       FROM api_keys WHERE merchant_id = $1 ORDER BY created_at`,
    [merchantId],
  );
  assert.equal(rows.rowCount, 2);
  const [oldRow, newRow] = rows.rows;
  assert.ok(oldRow!.revoked_at, "rotation revokes the previous key");
  assert.equal(oldRow!.revoked_reason, "rotated");
  assert.equal(newRow!.id, rotated.id);
  assert.equal(newRow!.revoked_at, null);
  assert.equal(newRow!.created_by, null, "0037's XOR: an admin-issued key has no merchant_users actor");
  assert.equal(newRow!.created_by_admin_user_id, finance.id);
  assert.equal(newRow!.rotated_from_key_id, original.id);
  assert.equal(newRow!.label, "rotated by admin");

  const audit = await auditRowsFor(finance.id, "api_key_rotate");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.target_id, original.id);
  assert.equal((audit[0]!.metadata as { newKeyId?: string }).newKeyId, rotated.id);
});

test("rotating an already-revoked key is a 409; rotating another merchant's key is a 404", async () => {
  const finance = await signedInAdmin("finance", "rotate-edge");
  const { merchantId, ownerUserId } = await createMerchant("rotate-edge");
  const other = await createMerchant("rotate-edge-other");
  const key = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "k" });

  // A key can be revoked by the merchant's own self-service revoke,
  // independent of admin rotation — that path is unaffected by this
  // endpoint and is what this test exercises.
  await pool.query(`UPDATE api_keys SET revoked_at = now(), revoked_reason = 'merchant_revoked' WHERE id = $1`, [key.id]);

  const second = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/api-keys/${key.id}/rotate`,
    headers: { cookie: finance.cookie },
    payload: {},
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "api_key_already_revoked");

  // Merchant-scoped by construction: the key exists, but not under this merchant.
  const crossTenant = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${other.merchantId}/api-keys/${key.id}/rotate`,
    headers: { cookie: finance.cookie },
    payload: {},
  });
  assert.equal(crossTenant.statusCode, 404);
});

// -------------------------------------------- webhook batch replay

async function createFailedDeliveries(
  merchantId: string,
  endpointId: string,
  specs: Array<{ status: string; createdAt: string }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    // A deliberately inert event_type: webhook_deliveries only needs *an*
    // outbox_events row to point at, and using a real rollup-eligible type
    // here would feed a meaningless synthetic event to apps/reporting's
    // consumer the next time it runs against this database.
    const outbox = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, processed_at)
       VALUES ('admin.test.replay_fixture', 'transaction', $1, $2::jsonb, now()) RETURNING id`,
      [randomUUID(), JSON.stringify({ merchantId })],
    );
    const deliveryEventId = randomUUID();
    const delivery = await pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
          (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, attempt_count, created_at)
       VALUES ($1, $2, 'transaction.captured', $3, $4::jsonb, $5, 8, $6)
       RETURNING id`,
      [
        endpointId,
        outbox.rows[0]!.id,
        deliveryEventId,
        JSON.stringify({ id: deliveryEventId, type: "transaction.captured", data: { merchantId } }),
        spec.status,
        spec.createdAt,
      ],
    );
    ids.push(delivery.rows[0]!.id);
  }
  return ids;
}

test("webhook batch replay replays every matching failed delivery in range, once each, with one audit row", async () => {
  const admin = await signedInAdmin("support", "replay");
  const { merchantId } = await createMerchant("replay");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  const inRange = await createFailedDeliveries(merchantId, endpoint.id, [
    { status: "exhausted", createdAt: "2026-05-02T00:00:00Z" },
    { status: "exhausted", createdAt: "2026-05-03T00:00:00Z" },
    { status: "exhausted", createdAt: "2026-05-04T00:00:00Z" },
  ]);
  const excluded = await createFailedDeliveries(merchantId, endpoint.id, [
    { status: "exhausted", createdAt: "2026-04-01T00:00:00Z" }, // before the window
    { status: "exhausted", createdAt: "2026-06-01T00:00:00Z" }, // after the window
    { status: "succeeded", createdAt: "2026-05-03T12:00:00Z" }, // wrong status
    { status: "pending", createdAt: "2026-05-03T13:00:00Z" },
  ]);

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-05-01T00:00:00Z", to: "2026-05-05T00:00:00Z" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { matchedCount: number; replayedDeliveryIds: string[] };
  assert.equal(body.matchedCount, 3, "defaults to statuses=['exhausted'] and honors the date window");
  assert.equal(body.replayedDeliveryIds.length, 3);
  assert.equal(new Set(body.replayedDeliveryIds).size, 3);

  // Each new row is a real replay of a distinct original, produced by the
  // same per-delivery logic the merchant-facing route uses: pending, due
  // now, with a FRESH delivery_event_id echoed into the stored envelope.
  const replays = await pool.query<{
    id: string;
    status: string;
    replay_of_delivery_id: string;
    delivery_event_id: string;
    payload: { id: string };
  }>(
    `SELECT id, status, replay_of_delivery_id, delivery_event_id, payload
       FROM webhook_deliveries WHERE id = ANY($1)`,
    [body.replayedDeliveryIds],
  );
  assert.equal(replays.rowCount, 3);
  const originals = new Set<string>();
  for (const row of replays.rows) {
    assert.equal(row.status, "pending");
    assert.ok(inRange.includes(row.replay_of_delivery_id));
    originals.add(row.replay_of_delivery_id);
    assert.equal(row.payload.id, row.delivery_event_id, "envelope id must match the fresh delivery_event_id");
  }
  assert.equal(originals.size, 3, "each in-range original replayed exactly once");

  // Nothing outside the selection was touched.
  const untouched = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM webhook_deliveries WHERE replay_of_delivery_id = ANY($1)`,
    [excluded],
  );
  assert.equal(untouched.rows[0]!.count, "0");

  const audit = await auditRowsFor(admin.id, "webhook_batch_replay");
  assert.equal(audit.length, 1, "one audit row for the whole batch, not one per delivery");
  assert.equal(audit[0]!.target_type, "webhook_endpoint");
  assert.equal(audit[0]!.target_id, endpoint.id);
  assert.equal((audit[0]!.metadata as { replayedDeliveryIds: string[] }).replayedDeliveryIds.length, 3);
});

test("webhook batch replay accepts an explicit statuses filter, and rejects bad input / foreign endpoints", async () => {
  const admin = await signedInAdmin("finance", "replay-edge");
  const { merchantId } = await createMerchant("replay-edge");
  const other = await createMerchant("replay-edge-other");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  await createFailedDeliveries(merchantId, endpoint.id, [
    { status: "succeeded", createdAt: "2026-05-03T00:00:00Z" },
  ]);

  const explicit = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-05-01T00:00:00Z", to: "2026-05-05T00:00:00Z", statuses: ["succeeded"] },
  });
  assert.equal(explicit.statusCode, 200, explicit.body);
  assert.equal((explicit.json() as { matchedCount: number }).matchedCount, 1);

  const missingRange = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: {},
  });
  assert.equal(missingRange.statusCode, 400);

  const inverted = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-05-05T00:00:00Z", to: "2026-05-01T00:00:00Z" },
  });
  assert.equal(inverted.statusCode, 400);

  // The endpoint exists, but not under this merchant.
  const crossTenant = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${other.merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-05-01T00:00:00Z", to: "2026-05-05T00:00:00Z" },
  });
  assert.equal(crossTenant.statusCode, 404);

  // A disabled endpoint is a 409, same as the single-delivery replay route.
  await pool.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [endpoint.id]);
  const disabled = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${endpoint.id}/replay-batch`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-05-01T00:00:00Z", to: "2026-05-05T00:00:00Z" },
  });
  assert.equal(disabled.statusCode, 409);
});

// ------------------------------------------------------ impersonation

// covers support only. finance/super_admin impersonation not tested — MK
test("a support impersonation grant reads merchant data but cannot perform owner/finance writes, and dies when ended", async () => {
  // A support operator is the least-privileged admin; a grant expresses that
  // standing in the merchant plane, so owner/finance-gated writes stay closed.
  const admin = await signedInAdmin("support", "imp");
  const { merchantId } = await createMerchant("imp");

  const startRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(startRes.statusCode, 201, startRes.body);
  const started = startRes.json() as { grantId: string; merchantId: string; expiresAt: string };
  assert.equal(started.merchantId, merchantId);
  assert.ok(new Date(started.expiresAt).getTime() > Date.now());
  const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);

  // READ: works, scoped to the impersonated merchant.
  const readRes = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { cookie: impCookie },
  });
  assert.equal(readRes.statusCode, 200, readRes.body);

  // WRITE, owner/finance-gated: refused by the platform's existing role gate,
  // because the grant resolves to merchant role 'support'.
  const createLinkRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { cookie: impCookie },
    payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(createLinkRes.statusCode, 403, createLinkRes.body);
  assert.equal(createLinkRes.json().error, "forbidden");

  const createEndpointRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: { cookie: impCookie },
    payload: { url: "http://127.0.0.1:9/hook" },
  });
  assert.equal(createEndpointRes.statusCode, 403);

  // The impersonation cookie confers ZERO admin authority.
  const adminProbe = await app.inject({
    method: "GET",
    url: "/v1/admin/auth/me",
    headers: { cookie: impCookie },
  });
  assert.equal(adminProbe.statusCode, 401, "fp_impersonation must never satisfy requireAdminSession");
  const adminListProbe = await app.inject({
    method: "GET",
    url: "/v1/admin/merchants",
    headers: { cookie: impCookie },
  });
  assert.equal(adminListProbe.statusCode, 401);

  // ...and the admin's own session is completely unaffected by any of this.
  const stillAdmin = await app.inject({
    method: "GET",
    url: "/v1/admin/auth/me",
    headers: { cookie: admin.cookie },
  });
  assert.equal(stillAdmin.statusCode, 200);

  // Conversely, an admin session cookie alone is not merchant authority.
  const adminAsMerchant = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { cookie: admin.cookie },
  });
  assert.equal(adminAsMerchant.statusCode, 401, "fp_admin_sid must never satisfy requireMerchantAuth");

  // End it.
  const endRes = await app.inject({
    method: "POST",
    url: `/v1/admin/impersonation/${started.grantId}/end`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(endRes.statusCode, 204);

  const afterEnd = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { cookie: impCookie },
  });
  assert.equal(afterEnd.statusCode, 401, "the grant token must be dead after ending");

  const audit = await pool.query<{ action: string; target_id: string }>(
    `SELECT action, target_id FROM admin_audit_log WHERE admin_user_id = $1 ORDER BY created_at`,
    [admin.id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ["impersonation_start", "impersonation_end"],
  );
  assert.equal(audit.rows[0]!.target_id, merchantId);
  assert.equal(audit.rows[1]!.target_id, merchantId);
});

test("an impersonation grant is read-only: it cannot capture or void, and a super_admin grant is still support", async () => {
  const supportAdmin = await signedInAdmin("support", "imp-write");
  const superAdmin = await signedInAdmin("super_admin", "imp-write-super");
  const { merchantId } = await createMerchant("imp-write");
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'authorized', 2000, 0, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  const transactionId = txn.rows[0]!.id;

  async function grantCookie(adminCookie: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/impersonate`,
      headers: { cookie: adminCookie },
    });
    assert.equal(res.statusCode, 201, res.body);
    return parseCookie(res.headers["set-cookie"], config.impersonationCookieName);
  }

  for (const impCookie of [await grantCookie(supportAdmin.cookie), await grantCookie(superAdmin.cookie)]) {
    const capture = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/capture`,
      headers: { cookie: impCookie, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(capture.statusCode, 403, capture.body);

    const voided = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/void`,
      headers: { cookie: impCookie, "idempotency-key": randomUUID() },
    });
    assert.equal(voided.statusCode, 403, voided.body);

    const reconciliation = await app.inject({
      method: "GET",
      url: "/v1/settlement/reconciliation",
      headers: { cookie: impCookie },
    });
    assert.equal(reconciliation.statusCode, 403, "an owner/finance page must stay closed to every grant");
  }

  const after = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  assert.deepEqual(after.rows[0], { status: "authorized", captured_fils: "0" });
});

test("an expired impersonation grant stops working without anyone ending it", async () => {
  const admin = await signedInAdmin("support", "imp-expiry");
  const { merchantId } = await createMerchant("imp-expiry");

  const startRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  const started = startRes.json() as { grantId: string };
  const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);

  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie: impCookie } })).statusCode,
    200,
  );

  // Only expires_at changes — ended_at and revoked_at stay null, so this
  // proves expiry alone closes the window.
  await pool.query(`UPDATE admin_impersonation_grants SET expires_at = now() - interval '1 second' WHERE id = $1`, [
    started.grantId,
  ]);

  const after = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie: impCookie } });
  assert.equal(after.statusCode, 401);
});

test("one admin cannot end another admin's impersonation grant", async () => {
  const owner = await signedInAdmin("support", "imp-owner");
  const other = await signedInAdmin("super_admin", "imp-other");
  const { merchantId } = await createMerchant("imp-scope");

  const startRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: owner.cookie },
  });
  const started = startRes.json() as { grantId: string };
  const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);

  const foreignEnd = await app.inject({
    method: "POST",
    url: `/v1/admin/impersonation/${started.grantId}/end`,
    headers: { cookie: other.cookie },
  });
  assert.equal(foreignEnd.statusCode, 404);
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie: impCookie } })).statusCode,
    200,
    "a foreign end attempt must not have ended the grant",
  );
  assert.equal((await auditRowsFor(other.id, "impersonation_end")).length, 0);

  const ownEnd = await app.inject({
    method: "POST",
    url: `/v1/admin/impersonation/${started.grantId}/end`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(ownEnd.statusCode, 204);

  // Ending twice is a 404, not a second audit row.
  const again = await app.inject({
    method: "POST",
    url: `/v1/admin/impersonation/${started.grantId}/end`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(again.statusCode, 404);
  assert.equal((await auditRowsFor(owner.id, "impersonation_end")).length, 1);
});

test("impersonating an unknown merchant is a 404 and issues no cookie", async () => {
  const admin = await signedInAdmin("support", "imp-404");
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${randomUUID()}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal((await auditRowsFor(admin.id, "impersonation_start")).length, 0);
});

// ------------------------------------ settlement re-run / rebuild

test("settlement run-batch: the audit row is COMMITTED before the call is made, then marked succeeded", async () => {
  const finance = await signedInAdmin("finance", "runbatch");
  settlementSpy.runBatchCalls = [];

  let auditVisibleDuringCall: Array<{ outcome: string }> = [];
  settlementSpy.runBatchImpl = async () => {
    // A separate connection, outside the route's transaction: if this can
    // see the row, the row is committed, which is the invariant.
    const seen = await pool.query<{ outcome: string }>(
      `SELECT outcome FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'settlement_run_batch'`,
      [finance.id],
    );
    auditVisibleDuringCall = seen.rows;
    return {
      businessDate: "2026-09-09",
      merchantResults: [
        {
          merchantId: randomUUID(),
          batchId: randomUUID(),
          alreadyClosed: false,
          alreadyPaid: false,
          grossFils: 1000,
          feeFils: 25,
          netPayoutFils: 975,
        },
      ],
    };
  };

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/settlement/run-batch",
    headers: { cookie: finance.cookie },
    payload: { date: "2026-09-09" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as RunBatchSummary;
  assert.equal(body.businessDate, "2026-09-09");
  assert.equal(body.merchantResults.length, 1);

  assert.deepEqual(settlementSpy.runBatchCalls, [{ date: "2026-09-09", merchantId: undefined }]);
  assert.equal(auditVisibleDuringCall.length, 1, "the attempt must be on record BEFORE the call happens");

  const audit = await auditRowsFor(finance.id, "settlement_run_batch");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.target_type, "platform");
  assert.equal(audit[0]!.target_id, null);
  assert.equal(audit[0]!.outcome, "succeeded");
  assert.equal((audit[0]!.metadata as { date?: string }).date, "2026-09-09");
  assert.equal((audit[0]!.metadata as { merchantResultCount?: number }).merchantResultCount, 1);

  settlementSpy.runBatchImpl = async () => ({ businessDate: "2026-09-09", merchantResults: [] });
});

test("settlement run-batch: a failing call surfaces its status and leaves an audit row marked failed", async () => {
  const finance = await signedInAdmin("finance", "runbatch-fail");
  settlementSpy.runBatchCalls = [];
  const { AppError } = await import("../lib/errors.js");
  settlementSpy.runBatchImpl = async () => {
    throw new AppError(502, "settlement_unreachable", "connect ECONNREFUSED");
  };

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/settlement/run-batch",
    headers: { cookie: finance.cookie },
    payload: { date: "2026-09-10", merchantId: randomUUID() },
  });
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.json().error, "settlement_unreachable");
  assert.equal(settlementSpy.runBatchCalls.length, 1);

  const audit = await auditRowsFor(finance.id, "settlement_run_batch");
  assert.equal(audit.length, 1, "a failed action is still recorded exactly once — never silently unlogged");
  assert.equal(audit[0]!.outcome, "failed");
  assert.equal(audit[0]!.target_type, "merchant");
  assert.equal((audit[0]!.metadata as { error?: string }).error, "settlement_unreachable");

  settlementSpy.runBatchImpl = async () => ({ businessDate: "2026-09-09", merchantResults: [] });
});

test("settlement run-batch validates its input before writing an audit row or calling anything", async () => {
  const finance = await signedInAdmin("finance", "runbatch-bad");
  settlementSpy.runBatchCalls = [];

  for (const payload of [{}, { date: "09/09/2026" }, { date: "2026-09-09", merchantId: "nope" }]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/settlement/run-batch",
      headers: { cookie: finance.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(settlementSpy.runBatchCalls.length, 0);
  assert.equal((await auditRowsFor(finance.id, "settlement_run_batch")).length, 0);
});

// stubbed settlement client, so this says nothing about what the Go side computes — FH
test("balance rebuild: calls the settlement client, surfaces only changed rows, and audits before/after", async () => {
  const admin = await signedInAdmin("super_admin", "rebuild");
  settlementSpy.rebuildCalls = 0;

  let auditVisibleDuringCall = 0;
  settlementSpy.rebuildImpl = async () => {
    const seen = await pool.query(
      `SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'balance_rebuild'`,
      [admin.id],
    );
    auditVisibleDuringCall = seen.rowCount ?? 0;
    return {
      rebuiltCount: 3,
      changed: [{ merchantId: "11111111-1111-1111-1111-111111111111", before: 100, after: 250 }],
    };
  };

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/balances/rebuild",
    headers: { cookie: admin.cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    rebuiltCount: 3,
    changed: [{ merchantId: "11111111-1111-1111-1111-111111111111", before: 100, after: 250 }],
  });
  assert.equal(settlementSpy.rebuildCalls, 1);
  assert.equal(auditVisibleDuringCall, 1, "the attempt must be on record BEFORE the call happens");

  const audit = await auditRowsFor(admin.id, "balance_rebuild");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.target_type, "platform");
  assert.equal(audit[0]!.target_id, null, "a platform-wide action has no single target");
  assert.equal(audit[0]!.outcome, "succeeded");
  assert.equal((audit[0]!.metadata as { rebuiltCount?: number }).rebuiltCount, 3);
  assert.equal((audit[0]!.metadata as { changedCount?: number }).changedCount, 1);

  settlementSpy.rebuildImpl = async () => ({ rebuiltCount: 0, changed: [] });
});

test("balance rebuild: a failing call surfaces its status and marks the audit row failed", async () => {
  const admin = await signedInAdmin("finance", "rebuild-fail");
  settlementSpy.rebuildCalls = 0;
  const { AppError } = await import("../lib/errors.js");
  settlementSpy.rebuildImpl = async () => {
    throw new AppError(500, "settlement_run_failed", "settlement returned 500");
  };

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/balances/rebuild",
    headers: { cookie: admin.cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 500, res.body);
  assert.equal(res.json().error, "settlement_run_failed");
  assert.equal(settlementSpy.rebuildCalls, 1);

  const audit = await auditRowsFor(admin.id, "balance_rebuild");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.outcome, "failed");
  assert.equal((audit[0]!.metadata as { error?: string }).error, "settlement_run_failed");

  settlementSpy.rebuildImpl = async () => ({ rebuiltCount: 0, changed: [] });
});

test("a settlement action whose audit row cannot be written never makes the call at all", async () => {
  const admin = await signedInAdmin("finance", "rebuild-auditfail");
  settlementSpy.rebuildCalls = 0;

  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_rebuild_audit CHECK (action <> 'balance_rebuild') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/balances/rebuild",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_rebuild_audit`);
  }

  assert.equal(settlementSpy.rebuildCalls, 0, "an unloggable action must be BLOCKED, not merely unlogged");
});

test("cookieValue helper sanity: the impersonation and admin cookies are genuinely different tokens", async () => {
  const admin = await signedInAdmin("support", "cookie-sanity");
  const { merchantId } = await createMerchant("cookie-sanity");
  const startRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);
  assert.notEqual(cookieValue(impCookie), cookieValue(admin.cookie));

  // The two tables share no token: the admin token must not resolve as a
  // grant, and the grant token must not resolve as a session.
  const { sha256Hex } = await import("../lib/crypto.js");
  const grantByAdminToken = await pool.query(
    `SELECT 1 FROM admin_impersonation_grants WHERE token_hash = $1`,
    [sha256Hex(cookieValue(admin.cookie))],
  );
  assert.equal(grantByAdminToken.rowCount, 0);
  const sessionByGrantToken = await pool.query(`SELECT 1 FROM admin_sessions WHERE token_hash = $1`, [
    sha256Hex(cookieValue(impCookie)),
  ]);
  assert.equal(sessionByGrantToken.rowCount, 0);
});

// ------------------------------------------------------- mdr recalculation

/** Settlement client is stubbed; this checks the audit choreography only, not what gets recalculated. */
test("mdr recalculation: the audit row is COMMITTED before the call, then marked succeeded", async () => {
  const admin = await signedInAdmin("finance", "mdr-happy");
  const { merchantId } = await createMerchant("mdr-happy");
  settlementSpy.recalcMdrCalls = [];

  let auditVisibleDuringCall: { outcome: string; metadata: Record<string, unknown> } | undefined;
  settlementSpy.recalcMdrImpl = async () => {
    // A separate pool query mid-call: it can only see the row if the audit
    // insert's transaction already COMMITTED before the call was made.
    const during = await pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
      `SELECT outcome, metadata FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = 'mdr_recalculation'`,
      [admin.id],
    );
    auditVisibleDuringCall = during.rows[0];
    return {
      batchesConsidered: 3,
      adjusted: [
        {
          batchId: randomUUID(),
          batchDate: "2026-04-02",
          status: "closed",
          oldFeeFils: 100,
          newFeeFils: 120,
          diffFils: 20,
        },
      ],
    };
  };

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as MdrRecalcSummary).batchesConsidered, 3);

  assert.deepEqual(settlementSpy.recalcMdrCalls, [
    { merchantId, from: "2026-04-01", to: "2026-04-30" },
  ]);

  assert.ok(auditVisibleDuringCall, "the attempt row must be committed before the call is made");
  assert.deepEqual(auditVisibleDuringCall.metadata, { from: "2026-04-01", to: "2026-04-30" });

  const rows = await auditRowsFor(admin.id, "mdr_recalculation");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "succeeded");
  assert.equal(rows[0]!.target_type, "merchant");
  assert.equal(rows[0]!.target_id, merchantId);
  assert.equal(rows[0]!.metadata.batchesConsidered, 3);
  assert.equal(rows[0]!.metadata.adjustedCount, 1);

  settlementSpy.recalcMdrImpl = async () => ({ batchesConsidered: 0, adjusted: [] });
});

test("mdr recalculation: a failing call surfaces its status and leaves an audit row marked failed", async () => {
  const admin = await signedInAdmin("finance", "mdr-fail");
  const { merchantId } = await createMerchant("mdr-fail");

  const { AppError } = await import("../lib/errors.js");
  settlementSpy.recalcMdrImpl = async () => {
    throw new AppError(502, "settlement_unreachable", "connection refused");
  };

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
    headers: { cookie: admin.cookie },
    payload: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(res.statusCode, 502, res.body);

  const rows = await auditRowsFor(admin.id, "mdr_recalculation");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "failed");
  assert.equal(rows[0]!.metadata.error, "settlement_unreachable");

  settlementSpy.recalcMdrImpl = async () => ({ batchesConsidered: 0, adjusted: [] });
});

test("mdr recalculation validates its input before writing an audit row or calling anything", async () => {
  const admin = await signedInAdmin("finance", "mdr-validate");
  const { merchantId } = await createMerchant("mdr-validate");
  settlementSpy.recalcMdrCalls = [];

  for (const payload of [
    {},
    { from: "2026-04-01" },
    { to: "2026-04-30" },
    { from: "01-04-2026", to: "2026-04-30" },
    { from: "2026-04-01", to: "not-a-date" },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
      headers: { cookie: admin.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }

  assert.equal(settlementSpy.recalcMdrCalls.length, 0);
  assert.equal((await auditRowsFor(admin.id, "mdr_recalculation")).length, 0);
});

test("mdr recalculation: a non-UUID merchant id is a 404", async () => {
  const admin = await signedInAdmin("finance", "mdr-404");
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/not-a-uuid/mdr-recalculation",
    headers: { cookie: admin.cookie },
    payload: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(res.statusCode, 404, res.body);
});

test("mdr recalculation is finance-gated and requires a session", async () => {
  const { merchantId } = await createMerchant("mdr-gate");

  const anon = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
    payload: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(anon.statusCode, 401, anon.body);

  const support = await signedInAdmin("support", "mdr-gate-support");
  const forbidden = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
    headers: { cookie: support.cookie },
    payload: { from: "2026-04-01", to: "2026-04-30" },
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});

test("an mdr recalculation whose audit row cannot be written never makes the call at all", async () => {
  const admin = await signedInAdmin("finance", "mdr-auditfail");
  const { merchantId } = await createMerchant("mdr-auditfail");
  settlementSpy.recalcMdrCalls = [];

  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_mdr_audit CHECK (action <> 'mdr_recalculation') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/mdr-recalculation`,
      headers: { cookie: admin.cookie },
      payload: { from: "2026-04-01", to: "2026-04-30" },
    });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_mdr_audit`);
  }

  assert.equal(
    settlementSpy.recalcMdrCalls.length,
    0,
    "an unloggable action must be BLOCKED, not merely unlogged",
  );
});
