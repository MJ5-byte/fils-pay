import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { verifyPassword } from "../auth/passwords.js";
import { issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  revokeSession,
} from "../auth/sessions.js";
import { findOtpRecipient } from "../auth/users.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

/**
 * `max_attempts` caps the guesses on one challenge, but every password login
 * issues a fresh challenge. Counting wrong codes across the user's recent
 * challenges stops re-logging in from resetting the guess budget: at most 10
 * wrong codes per 15 minutes, so about 960 a day against a million 6-digit codes.
 */
const OTP_FAILURE_LIMIT = 10;
const OTP_FAILURE_WINDOW_MINUTES = 15;

async function hasTooManyRecentOtpFailures(db: Pool | PoolClient, merchantUserId: string): Promise<boolean> {
  const result = await db.query<{ failures: number }>(
    `SELECT COALESCE(SUM(attempt_count), 0)::int AS failures
       FROM otp_challenges
      WHERE merchant_user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [merchantUserId, OTP_FAILURE_WINDOW_MINUTES],
  );
  return (result.rows[0]?.failures ?? 0) >= OTP_FAILURE_LIMIT;
}

interface LoginBody {
  merchantId?: string;
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
}

/**
 * Merchant login is two-step: POST /login checks merchantId+email+password
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** POST /v1/auth/login — step 1. */
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { merchantId, email, password } = request.body ?? {};
    if (!merchantId || !email || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }

    const userResult = await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
      [merchantId, email],
    );
    const user = userResult.rows[0];

    // timing-safe: hashes against a dummy when the user is missing. correct — FH
    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    const recipient = await findOtpRecipient(app.db, user.merchant_id, email) ?? user;
    if (await hasTooManyRecentOtpFailures(app.db, recipient.id)) {
      throw new TooManyRequestsError("too_many_attempts");
    }

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);

    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }

      // Count, compare and record the guess in one transaction behind a lock on
      // the user row, so parallel verifies queue up instead of all reading a
      // failure count that is still under the limit.
      const outcome = await withTransaction(app.db, async (client) => {
        await client.query(`SELECT id FROM merchant_users WHERE id = $1 FOR UPDATE`, [pending.merchantUserId]);
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
             FROM otp_challenges WHERE id = $1`,
          [pending.otpChallengeId],
        );
        const challenge = challengeResult.rows[0];
        if (!challenge || challenge.consumed_at !== null || challenge.expires_at.getTime() <= Date.now()) {
          return { kind: "expired" } as const;
        }
        if (
          challenge.attempt_count >= challenge.max_attempts ||
          (await hasTooManyRecentOtpFailures(client, pending.merchantUserId))
        ) {
          return { kind: "locked" } as const;
        }

        if (!verifyOtpCode(code, challenge.code_salt, challenge.code_hash)) {
          const counted = await client.query(
            `UPDATE otp_challenges SET attempt_count = attempt_count + 1
              WHERE id = $1 AND attempt_count < max_attempts RETURNING id`,
            [challenge.id],
          );
          return { kind: counted.rowCount === 1 ? "wrong" : "locked" } as const;
        }

        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
        // promoteSession bumps expires_at to 12h server-side; the cookie maxAge doesn't matter because
        // MK: admin verify re-sets the cookie after this, merchant verify doesnt. related to the 10 min logouts?
        await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        return { kind: "verified", user: result.rows[0] } as const;
      });
      if (outcome.kind === "expired") {
        throw new GoneError("otp_expired");
      }
      if (outcome.kind === "locked") {
        await revokeSession(app.db, pending.sessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }
      if (outcome.kind === "wrong") {
        throw new UnauthorizedError("invalid_code");
      }
      const merchantUserResult = outcome.user;
      if (!merchantUserResult) {
        throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
      }

      reply.code(200).send({
        authenticated: true,
        merchantId: merchantUserResult.merchant_id,
        role: merchantUserResult.role,
      });
    },
  );

  /**
   * Re-issues the OTP for a pending session. Throttled to one per 30s. The
   * new challenge inherits the previous challenge's attempt_count so a
   * resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[app.config.cookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    const existing = await app.db.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM otp_challenges WHERE id = $1`,
      [pending.otpChallengeId],
    );
    const existingChallenge = existing.rows[0];
    if (existingChallenge && Date.now() - existingChallenge.created_at.getTime() < 30_000) {
      throw new TooManyRequestsError("resend_too_soon");
    }

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      // Lock the user row first, in the same order as /otp/verify: the new
      // challenge's foreign key needs a share lock on this row, and taking it
      // after touching the old challenge would deadlock against a verify.
      await client.query(`SELECT id FROM merchant_users WHERE id = $1 FOR UPDATE`, [pending.merchantUserId]);
      if (existingChallenge) {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [
          existingChallenge.id,
        ]);
      }
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      await client.query(`UPDATE sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.sessionId,
      ]);
      return challenge;
    });

    const userResult = await app.db.query<{ email: string }>(
      `SELECT email FROM merchant_users WHERE id = $1`,
      [pending.merchantUserId],
    );
    sendOtpCode(
      request.log,
      app.config,
      { merchantUserId: pending.merchantUserId, email: userResult.rows[0]?.email ?? "" },
      code,
    );

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.get(
    "/me",
    { preHandler: requireSession },
    async (request: FastifyRequest) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      const result = await app.db.query<{
        email: string;
        merchant_id: string;
        display_name: string;
        onboarding_status: string;
      }>(
        `SELECT mu.email, m.id AS merchant_id, m.display_name, m.onboarding_status
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.id = $1`,
        [auth.merchantUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedError("unauthenticated");
      }
      return {
        merchantUserId: auth.merchantUserId,
        email: row.email,
        role: auth.role,
        merchant: {
          id: row.merchant_id,
          displayName: row.display_name,
          onboardingStatus: row.onboarding_status,
        },
      };
    },
  );

  app.post(
    "/logout",
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeSession(app.db, auth.sessionId);
      reply.setCookie(app.config.cookieName, "", {
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
