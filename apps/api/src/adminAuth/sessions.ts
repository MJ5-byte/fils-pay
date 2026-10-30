import type { Pool, PoolClient } from "pg";
import { randomToken, sha256Hex } from "../lib/crypto.js";

export type AdminRole = "support" | "finance" | "super_admin";

/** @property expiresAt The short pending TTL; promoteAdminSession extends it. */
export interface CreatedAdminSession {
  id: string;
  rawToken: string;
  expiresAt: Date;
}

/**
 * Mirrors `auth/sessions.ts` against `admin_sessions`/`admin_user_id`. These
 * five functions are deliberately a separate implementation rather than a
 * parameterized shared one: the two tables are separate on purpose (0033),
 * and a single "sessions" helper taking a table name would be exactly the
 * kind of shared surface through which an admin token could one day be
 * resolved by a merchant-facing lookup, or vice versa.
 *
 * Inserts a session row at step 1 of login: password verified, OTP not yet
 * verified. `authenticated` defaults to false at the schema level; this
 * function never sets it true. The raw token is returned so the caller can
 * hand it to the client as a cookie — only its sha256 hash is ever stored.
 */
export async function createPendingAdminSession(
  client: PoolClient,
  params: {
    adminUserId: string;
    otpChallengeId: string;
    ttlMinutes: number;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CreatedAdminSession> {
  const rawToken = randomToken(32);
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60_000);

  const result = await client.query<{ id: string }>(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, otp_challenge_id, authenticated, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, false, $4, $5, $6)
     RETURNING id`,
    [
      params.adminUserId,
      tokenHash,
      params.otpChallengeId,
      expiresAt,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createPendingAdminSession: insert into admin_sessions returned no row");
  }
  return { id: row.id, rawToken, expiresAt };
}

/**
 * Promotes a pending admin session to authenticated. The *only* place in
 * the codebase that ever sets `admin_sessions.authenticated = true` — always
 * at OTP verification success, never at token issuance.
 */
// YA: token not rotated on promote -> fixation. FP-198 (repro: copy the pending cookie into a 2nd browser before OTP)
// MK: the 2nd browser still needs the OTP. unresolved
export async function promoteAdminSession(
  client: PoolClient,
  adminSessionId: string,
  sessionTtlHours: number,
): Promise<{ expiresAt: Date; rawToken: string }> {
  const expiresAt = new Date(Date.now() + sessionTtlHours * 3_600_000);
  const rawToken = randomToken(32);
  const updated = await client.query(
    `UPDATE admin_sessions SET authenticated = true, authenticated_at = now(), expires_at = $2, token_hash = $3 WHERE id = $1 AND authenticated = false AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
    [adminSessionId, expiresAt, sha256Hex(rawToken)],
  );
  if (updated.rowCount !== 1) throw new Error("Cannot promote an expired, revoked or authenticated admin session");
  return { expiresAt, rawToken };
}

/**
 * Safe to call twice.
 * — MK
 */
export async function revokeAdminSession(
  client: PoolClient | Pool,
  adminSessionId: string,
): Promise<void> {
  await client.query(`UPDATE admin_sessions SET revoked_at = now() WHERE id = $1`, [adminSessionId]);
}

export interface AuthenticatedAdminSessionLookup {
  adminSessionId: string;
  adminUserId: string;
  email: string;
  role: AdminRole;
}

/**
 * The sole definition of "logged in as admin" anywhere in this codebase. No
 * other query re-implements it: always `token_hash = $1 AND authenticated =
 * true AND revoked_at IS NULL AND expires_at > now()`, plus the joined
 * `admin_users.status = 'active'` so disabling a staff account kills its
 * live sessions on the next request rather than at their next expiry.
 */
// MK: authenticated = true is mandatory here (0012). don't drop it
// FH: claude flagged authenticated = true as redundant with expires_at since pending sessions only live 10 min.
// removing in #460?
// dont. — am
export async function lookupAdminSession(
  pool: Pool,
  rawToken: string,
): Promise<AuthenticatedAdminSessionLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  const result = await pool.query<{
    admin_session_id: string;
    admin_user_id: string;
    email: string;
    role: AdminRole;
  }>(
    `SELECT s.id AS admin_session_id, s.admin_user_id, au.email, au.role
       FROM admin_sessions s
       JOIN admin_users au ON au.id = s.admin_user_id
      WHERE s.token_hash = $1
        AND s.authenticated = true
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND au.status = 'active'`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    adminSessionId: row.admin_session_id,
    adminUserId: row.admin_user_id,
    email: row.email,
    role: row.role,
  };
}

export interface PendingAdminSessionLookup {
  adminSessionId: string;
  adminUserId: string;
  otpChallengeId: string | null;
}

/** Looks up a pending (pre-OTP) admin session by its raw token. Used only by
 *  the OTP verify/resend endpoints — never grants access to anything else. */
export async function lookupPendingAdminSession(
  pool: Pool,
  rawToken: string,
): Promise<PendingAdminSessionLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  const result = await pool.query<{
    id: string;
    admin_user_id: string;
    otp_challenge_id: string | null;
  }>(
    `SELECT id, admin_user_id, otp_challenge_id
       FROM admin_sessions
      WHERE token_hash = $1
        AND authenticated = false
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    adminSessionId: row.id,
    adminUserId: row.admin_user_id,
    otpChallengeId: row.otp_challenge_id,
  };
}
