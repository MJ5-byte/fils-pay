/**
 * DB-backed tests for session lookup — the function every authenticated
 * route ultimately depends on to decide whether a request is logged in.
 * Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 *
 * These drive the exported functions directly rather than going through the
 * HTTP layer: what counts as a live session is a property of the query
 * itself, not of any particular route's preHandler.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { lookupSession } from "./sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "sessions.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

test.after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------- fixtures

/** A merchant with one owner, so each test owns its own identity and none of
 *  them depend on the seed or on one another. */
async function createMerchantUser(label: string): Promise<string> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Session Svc ${label} ${suffix.slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchant.rows[0]!.id, `${label}-${suffix}@sessions.test`],
  );
  return user.rows[0]!.id;
}

/** Inserts a session row directly, so each test states the exact row shape it
 *  is asserting about rather than arriving at one through the login flow. */
async function insertSession(params: {
  merchantUserId: string;
  authenticated: boolean;
  expiresAt: Date;
  revoked?: boolean;
}): Promise<string> {
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.merchantUserId,
      sha256Hex(rawToken),
      params.authenticated,
      params.expiresAt,
      params.revoked ? new Date() : null,
    ],
  );
  return rawToken;
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

// ------------------------------------------------------------------ tests

test("lookupSession returns null for a pending (pre-OTP) session", async () => {
  const merchantUserId = await createMerchantUser("pending");
  const rawToken = await insertSession({
    merchantUserId,
    authenticated: false,
    expiresAt: hoursFromNow(12),
  });

  assert.equal(await lookupSession(pool, rawToken), null, "a password-only session must grant nothing until OTP");
});

test("lookupSession finds an active, promoted session", async () => {
  const merchantUserId = await createMerchantUser("active");
  const rawToken = await insertSession({
    merchantUserId,
    authenticated: true,
    expiresAt: hoursFromNow(12),
  });

  const found = await lookupSession(pool, rawToken);
  assert.ok(found, "an unexpired, unrevoked session must resolve");
  assert.equal(found.merchantUserId, merchantUserId);
  assert.equal(found.role, "owner");
});

test("lookupSession returns null for an unknown token", async () => {
  // Never inserted anywhere — a well-formed token that simply isn't a session.
  assert.equal(await lookupSession(pool, randomToken(32)), null);
});

test("lookupSession returns null for a revoked session", async () => {
  const merchantUserId = await createMerchantUser("revoked");
  const rawToken = await insertSession({
    merchantUserId,
    authenticated: true,
    expiresAt: hoursFromNow(12),
    revoked: true,
  });

  assert.equal(await lookupSession(pool, rawToken), null, "revoked_at must exclude the row");
});

test("lookupSession returns null for an expired session", async () => {
  const merchantUserId = await createMerchantUser("expired");
  const rawToken = await insertSession({
    merchantUserId,
    authenticated: true,
    expiresAt: hoursFromNow(-1),
  });

  assert.equal(await lookupSession(pool, rawToken), null, "expires_at in the past must exclude the row");
});
