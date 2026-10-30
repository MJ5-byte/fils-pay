import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { revokeAdminImpersonationGrants } from "../admin/impersonation.js";
import { verifyPassword } from "../adminAuth/passwords.js";
import { issueAdminChallenge, verifyOtpCode } from "../adminAuth/otp.js";
import { sendAdminOtpCode } from "../adminAuth/notifier.js";
import { exposesOtpCode } from "../auth/notifier.js";
import { requireAdminSession } from "../adminAuth/middleware.js";
import {
  createPendingAdminSession,
  lookupPendingAdminSession,
  promoteAdminSession,
  revokeAdminSession,
  type AdminRole,
} from "../adminAuth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at the
 * same cost parameters this app defaults to. Verified against on every login
 * attempt for an email that doesn't resolve to an active admin, so a failed
 * lookup and a failed password check take comparable time.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

/**
 * `max_attempts` caps the guesses on one challenge, but every password login
 * issues a fresh challenge. Counting wrong codes across the admin's recent
 * challenges stops re-logging in from resetting the guess budget: at most 10
 * wrong codes per 15 minutes, so about 960 a day against a million 6-digit codes.
 */
const OTP_FAILURE_LIMIT = 10;
const OTP_FAILURE_WINDOW_MINUTES = 15;

async function hasTooManyRecentOtpFailures(db: Pool | PoolClient, adminUserId: string): Promise<boolean> {
  const result = await db.query<{ failures: number }>(
    `SELECT COALESCE(SUM(attempt_count), 0)::int AS failures
       FROM admin_otp_challenges
      WHERE admin_user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [adminUserId, OTP_FAILURE_WINDOW_MINUTES],
  );
  return (result.rows[0]?.failures ?? 0) >= OTP_FAILURE_LIMIT;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** status 'disabled' blocks login and kills existing sessions (requireAdminSession re-reads it). */
interface AdminUserRow {
  id: string;
  email: string;
  role: AdminRole;
  password_hash: string;
}

/**
 * Registered with prefix '/v1/admin/auth'. Structurally identical to the
 * merchant login (password -> OTP -> authenticated session), with one
 * simplification the schema makes possible: `admin_users.email` is globally
 * unique, so unlike merchant login there is no tenant id to disambiguate
 * with — the lookup is unambiguous by construction.
 *
 * Admin login requires OTP deliberately: this is the plane where the most
 * dangerous operations live, so it must not have a weaker login factor than
 * an ordinary merchant dashboard user.
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      throw new BadRequestError("invalid_request", "email and password are required");
    }

    const userResult = await app.db.query<AdminUserRow>(
      `SELECT id, email, role, password_hash FROM admin_users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    const user = userResult.rows[0];

    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic error in every failure case (no row, disabled
    // account, or wrong password) — the response never discloses which.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }
    if (await hasTooManyRecentOtpFailures(app.db, user.id)) {
      throw new TooManyRequestsError("too_many_attempts");
    }

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueAdminChallenge(client, {
        adminUserId: user.id,
        ttlMinutes: app.config.adminOtpTtlMinutes,
        codeLength: app.config.adminOtpCodeLength,
        maxAttempts: app.config.adminOtpMaxAttempts,
      });
      const session = await createPendingAdminSession(client, {
        adminUserId: user.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.adminPendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendAdminOtpCode(request.log, app.config, { adminUserId: user.id, email: user.email }, code);

    reply.setCookie(app.config.adminCookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminPendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    if (exposesOtpCode(app.config, user.email)) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>("/otp/verify", async (request, reply) => {
    const code = request.body?.code;
    if (!code) {
      throw new BadRequestError("invalid_request", "code is required");
    }

    const rawToken = request.cookies[app.config.adminCookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingAdminSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    // Count, compare and record the guess in one transaction behind a lock on
    // the admin row, so parallel verifies queue up instead of all reading a
    // failure count that is still under the limit.
    const outcome = await withTransaction(app.db, async (client) => {
      await client.query(`SELECT id FROM admin_users WHERE id = $1 FOR UPDATE`, [pending.adminUserId]);
      const challengeResult = await client.query<{
        id: string;
        code_salt: string;
        code_hash: string;
        attempt_count: number;
        max_attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, code_salt, code_hash, attempt_count, max_attempts, expires_at, consumed_at
           FROM admin_otp_challenges WHERE id = $1`,
        [pending.otpChallengeId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at !== null || challenge.expires_at.getTime() <= Date.now()) {
        return { kind: "expired" } as const;
      }
      if (
        challenge.attempt_count >= challenge.max_attempts ||
        (await hasTooManyRecentOtpFailures(client, pending.adminUserId))
      ) {
        return { kind: "locked" } as const;
      }

      if (!verifyOtpCode(code, challenge.code_salt, challenge.code_hash)) {
        const counted = await client.query(
          `UPDATE admin_otp_challenges SET attempt_count = attempt_count + 1
            WHERE id = $1 AND attempt_count < max_attempts RETURNING id`,
          [challenge.id],
        );
        return { kind: counted.rowCount === 1 ? "wrong" : "locked" } as const;
      }

      await client.query(`UPDATE admin_otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challenge.id,
      ]);
      await promoteAdminSession(client, pending.adminSessionId, app.config.adminSessionTtlHours);
      const result = await client.query<{ role: AdminRole }>(
        `SELECT role FROM admin_users WHERE id = $1`,
        [pending.adminUserId],
      );
      return { kind: "verified", user: result.rows[0] } as const;
    });
    if (outcome.kind === "expired") {
      throw new GoneError("otp_expired");
    }
    if (outcome.kind === "locked") {
      await revokeAdminSession(app.db, pending.adminSessionId);
      throw new TooManyRequestsError("too_many_attempts");
    }
    if (outcome.kind === "wrong") {
      throw new UnauthorizedError("invalid_code");
    }
    const adminUser = outcome.user;
    if (!adminUser) {
      throw new Error("admin otp/verify: admin_users row disappeared mid-transaction");
    }

    // Re-set the cookie so its browser-side lifetime matches the now-promoted
    // session's full TTL rather than the short pending window.
    // YA: why is the cookie set twice (login and verify)? Claude says remove one
    // FH: the second one re-issues at the full session TTL. the merchant flow should do the same
    reply.setCookie(app.config.adminCookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminSessionTtlHours * 3_600,
    });

    reply.code(200).send({
      authenticated: true,
      adminUserId: pending.adminUserId,
      role: adminUser.role,
    });
  });

  app.get("/me", { preHandler: requireAdminSession }, async (request: FastifyRequest) => {
    const auth = request.adminAuth;
    if (!auth) {
      throw new UnauthorizedError("unauthenticated");
    }
    return { adminUserId: auth.adminUserId, email: auth.email, role: auth.role };
  });

  app.post(
    "/logout",
    { preHandler: requireAdminSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.adminAuth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      // Grants ride their own cookie, so revoking the session alone would
      // leave "view as merchant" open until the grant's TTL runs out.
      await withTransaction(app.db, async (client) => {
        await revokeAdminSession(client, auth.adminSessionId);
        await revokeAdminImpersonationGrants(client, auth.adminUserId);
      });
      reply.setCookie(app.config.adminCookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}
