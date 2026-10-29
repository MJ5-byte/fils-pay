/**
 * A pending (password verified, OTP not yet verified) session must never
 * authenticate a request. lookupSession read the live_sessions view, which
 * filters revoked/expired rows but not `authenticated`, so the cookie issued
 * at step 1 of login was already a full session. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { lookupSession } from "./sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("sessions.pending.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

async function sessionToken(authenticated: boolean): Promise<string> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pending Session ${suffix.slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchant.rows[0]!.id, `pending-${suffix}@sessions.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [user.rows[0]!.id, sha256Hex(rawToken), authenticated],
  );
  return rawToken;
}

test("lookupSession returns null for a pending (pre-OTP) session", async () => {
  assert.equal(await lookupSession(pool, await sessionToken(false)), null);
});

test("lookupSession still resolves the same session once it is promoted", async () => {
  assert.notEqual(await lookupSession(pool, await sessionToken(true)), null);
});
