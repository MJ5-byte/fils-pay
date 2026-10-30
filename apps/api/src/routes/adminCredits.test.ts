/**
 * Route-level tests for the manual-credits plane, via `app.inject(...)`
 * against a real, migrated Postgres — no mocking of the DB layer. Requires
 * DATABASE_URL to point at one (run `npm run migrate` first).
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
    "adminCredits.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

// ---------------------------------------------------------------- helpers

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

/** Every fixture admin gets its own display name: real operators are
 *  distinct people, and a shared name across fixtures would make these tests
 *  depend on each other. */
async function signedInAdmin(role: AdminRole, label: string) {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const suffix = randomUUID();
  const email = `${label}-${suffix}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `${label} ${suffix.slice(0, 8)}`, role],
  );

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { devOtpCode?: string };
  let cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  // OTP verification issues a new session token (no session fixation).
  cookie = parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName);

  return { id: inserted.rows[0]!.id, email, cookie };
}

async function createMerchant(label: string, mdrBps = 250): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Credits Test ${label} ${randomUUID()}`, mdrBps],
  );
  return result.rows[0]!.id;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CreditRequestBody {
  id: string;
  status: string;
  requiresApproval: boolean;
  baseAmountFils: number;
  feeReversalFils: number;
  postedAmountFils: number;
  ledgerEntryGroupId: string | null;
}

async function issueCredit(
  cookie: string,
  merchantId: string,
  payload: Record<string, unknown>,
): Promise<CreditRequestBody> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/credits`,
    headers: { cookie },
    payload: { reasonCode: "goodwill", effectiveDate: todayIso(), ...payload },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as CreditRequestBody;
}

// ------------------------------------------------------------- auth gating

test("every credits route rejects an unauthenticated caller", async () => {
  const merchantId = await createMerchant("noauth");
  const routes: Array<["GET" | "POST", string]> = [
    ["GET", "/v1/admin/credits"],
    ["POST", `/v1/admin/merchants/${merchantId}/credits`],
    ["POST", `/v1/admin/credits/${randomUUID()}/approve`],
    ["POST", `/v1/admin/credits/${randomUUID()}/reject`],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url} -> ${res.body}`);
  }
});

// create isn't in this test, only approve/reject. intentional? — am
test("a support admin is 403'd on approve and reject — the decision that moves money", async () => {
  const finance = await signedInAdmin("finance", "gate-maker");
  const support = await signedInAdmin("support", "gate-checker");
  const merchantId = await createMerchant("gate");

  const pending = await issueCredit(finance.cookie, merchantId, { baseAmountFils: 120_000 });
  assert.equal(pending.status, "pending_approval");

  for (const action of ["approve", "reject"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/credits/${pending.id}/${action}`,
      headers: { cookie: support.cookie },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `${action} -> ${res.body}`);
    assert.equal(res.json().error, "forbidden");
  }

  // ...and nothing moved as a side effect of either attempt.
  const row = await pool.query<{ status: string }>(
    `SELECT status FROM credit_requests WHERE id = $1`,
    [pending.id],
  );
  assert.equal(row.rows[0]!.status, "pending_approval");
});

test("a support admin CAN read the credits queue — it is a read, like the merchant list", async () => {
  const support = await signedInAdmin("support", "queue-read");
  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/credits?status=pending_approval",
    headers: { cookie: support.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
});

// ------------------------------------------------------------ create route

test("a finance admin issues a below-threshold credit and it posts immediately", async () => {
  const finance = await signedInAdmin("finance", "create-small");
  const merchantId = await createMerchant("create-small");

  const record = await issueCredit(finance.cookie, merchantId, {
    baseAmountFils: 10_000,
    memo: "goodwill for the outage",
  });
  assert.equal(record.requiresApproval, false);
  assert.equal(record.status, "posted");
  assert.equal(record.feeReversalFils, 0);
  assert.equal(record.postedAmountFils, 10_000);
  assert.ok(record.ledgerEntryGroupId);

  const audit = await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'credit_request_created' AND target_id = $2`,
    [finance.id, record.id],
  );
  assert.equal(audit.rowCount, 1, "exactly one audit row per action");
  assert.equal(audit.rows[0]!.metadata.posted, true);
  assert.equal(audit.rows[0]!.metadata.postedAmountFils, 10_000);
});

/** Threshold is compared against the posted total (base + fee reversal), so 50000 base is above it. */
test("an above-threshold credit waits for a second approver and journals nothing yet", async () => {
  const finance = await signedInAdmin("finance", "create-big");
  const merchantId = await createMerchant("create-big");

  const record = await issueCredit(finance.cookie, merchantId, { baseAmountFils: 120_000 });
  assert.equal(record.requiresApproval, true);
  assert.equal(record.status, "pending_approval");
  assert.equal(record.ledgerEntryGroupId, null);

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0, "nothing may be journaled before the second signature");
  const balance = await pool.query(`SELECT 1 FROM merchant_balances WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(balance.rowCount, 0);
});

test("create validates its body and 404s an unknown or malformed merchant", async () => {
  const finance = await signedInAdmin("finance", "create-bad");
  const merchantId = await createMerchant("create-bad");

  for (const payload of [
    {},
    { baseAmountFils: 0, reasonCode: "goodwill", effectiveDate: todayIso() },
    { baseAmountFils: 1_000, reasonCode: "nope", effectiveDate: todayIso() },
    { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: "2026-02-30" },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/credits`,
      headers: { cookie: finance.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }

  for (const id of [randomUUID(), "not-a-uuid"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${id}/credits`,
      headers: { cookie: finance.cookie },
      payload: { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: todayIso() },
    });
    assert.equal(res.statusCode, 404, `${id} -> ${res.body}`);
  }
});

// ----------------------------------------------------------- approve/reject

test("a second finance admin approves a pending credit; approving it again is a 409", async () => {
  const maker = await signedInAdmin("finance", "approve-maker");
  const checker = await signedInAdmin("finance", "approve-checker");
  const merchantId = await createMerchant("approve");

  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });

  const first = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(first.statusCode, 200, first.body);
  const approved = first.json() as CreditRequestBody & { approvedByAdminUserId: string | null };
  assert.equal(approved.status, "posted");
  assert.equal(approved.approvedByAdminUserId, checker.id);
  assert.ok(approved.ledgerEntryGroupId);

  const second = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, "credit_request_not_pending");

  const groups = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT entry_group_id)::text AS count FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(groups.rows[0]!.count, "1", "a second approval must not journal a second time");
});

test("a rejected credit journals nothing and can no longer be approved", async () => {
  const maker = await signedInAdmin("finance", "reject-maker");
  const checker = await signedInAdmin("finance", "reject-checker");
  const merchantId = await createMerchant("reject");

  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });

  const rejected = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/reject`,
    headers: { cookie: checker.cookie },
    payload: { reason: "not supported by the dispute file" },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((rejected.json() as CreditRequestBody).status, "rejected");

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0);

  const approveAfter = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(approveAfter.statusCode, 409, approveAfter.body);
  assert.equal(approveAfter.json().error, "credit_request_not_pending");

  const audit = await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'credit_request_rejected' AND target_id = $2`,
    [checker.id, pending.id],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0]!.metadata.reason, "not supported by the dispute file");
});

test("approving or rejecting an unknown or malformed credit request is a 404", async () => {
  const finance = await signedInAdmin("finance", "approve-404");
  for (const id of [randomUUID(), "not-a-uuid"]) {
    for (const action of ["approve", "reject"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/admin/credits/${id}/${action}`,
        headers: { cookie: finance.cookie },
        payload: {},
      });
      assert.equal(res.statusCode, 404, `${action} ${id} -> ${res.body}`);
    }
  }
});

// -------------------------------------------------------------- list route

test("GET /v1/admin/credits filters by merchant and round-trips its keyset cursor", async () => {
  const finance = await signedInAdmin("finance", "list");
  const merchantId = await createMerchant("list");

  // Three rows written back-to-back, which is exactly when a
  // millisecond-truncated cursor starts skipping rows.
  const created: string[] = [];
  for (let i = 0; i < 3; i++) {
    created.push((await issueCredit(finance.cookie, merchantId, { baseAmountFils: 1_000 + i })).id);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const url: string = `/v1/admin/credits?merchantId=${merchantId}&limit=1${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    for (const item of body.items) seen.push(item.id);
    cursor = body.nextCursor;
    if (!cursor) break;
  }

  assert.equal(seen.length, 3, "every row must appear exactly once across the pages");
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual([...seen].sort(), [...created].sort());
});

test("GET /v1/admin/credits filters by status", async () => {
  const maker = await signedInAdmin("finance", "list-status-maker");
  const checker = await signedInAdmin("finance", "list-status-checker");
  const merchantId = await createMerchant("list-status");

  const posted = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 5_000 });
  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });
  const toReject = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 130_000 });
  await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${toReject.id}/reject`,
    headers: { cookie: checker.cookie },
    payload: {},
  });

  for (const [status, expected] of [
    ["posted", posted.id],
    ["pending_approval", pending.id],
    ["rejected", toReject.id],
  ] as Array<[string, string]>) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/credits?merchantId=${merchantId}&status=${status}`,
      headers: { cookie: maker.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { items: Array<{ id: string; status: string }> };
    assert.deepEqual(
      body.items.map((i) => i.id),
      [expected],
      `status=${status}`,
    );
  }
});
