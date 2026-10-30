import { beginLoginAttempt, clearLoginAttempt, assertChallengeAllowed, adminAccountKey, merchantAccountKey } from "../auth/loginLimits.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
    if (typeof merchantId !== "string" || !merchantId || typeof email !== "string" || !email || typeof password !== "string" || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }

    const attemptId = await beginLoginAttempt(app.db, reply, app.config, { plane: "merchant", accountKey: merchantAccountKey(merchantId, email), ip: request.ip });
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

    const recipient = user;

    await clearLoginAttempt(app.db, attemptId);
    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      await assertChallengeAllowed(client, reply, app.config, { plane: "merchant", userId: user.id });
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

      const challengeResult = await app.db.query<{
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
      if (!challenge || challenge.consumed_at !== null) {
        throw new GoneError("otp_expired");
      }
      if (challenge.expires_at.getTime() <= Date.now()) {
        throw new GoneError("otp_expired");
      }

      // Reserve a guess atomically, including successful attempts.
      const attempt = await app.db.query(
        `UPDATE otp_challenges SET attempt_count = attempt_count + 1 WHERE id = $1 AND attempt_count < max_attempts AND consumed_at IS NULL AND expires_at > now() RETURNING id`, [challenge.id]);
      if (attempt.rowCount === 0) {
        throw new TooManyRequestsError("too_many_attempts");
      }

      const matches = verifyOtpCode(code, challenge.code_salt, challenge.code_hash);
      if (!matches) throw new UnauthorizedError("invalid_code");

      const merchantUserResult = await withTransaction(app.db, async (client) => {
        const consumed = await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING id`, [challenge.id]);
        if (consumed.rowCount === 0) throw new GoneError("otp_expired");
        const promoted = await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        return result.rows[0] ? { ...result.rows[0], rawToken: promoted.rawToken } : undefined;
      });
      if (!merchantUserResult) {
        throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
      }

      reply.setCookie(app.config.cookieName, merchantUserResult.rawToken, { httpOnly: true, path: "/", sameSite: "lax", secure: app.config.cookieSecure, maxAge: app.config.sessionTtlHours * 3600 });
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

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      const locked = await client.query<{ otp_challenge_id: string }>(
        `SELECT otp_challenge_id FROM sessions WHERE id = $1 AND authenticated = false
          AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [pending.sessionId]);
      if (!locked.rows[0]) throw new UnauthorizedError("no_pending_session");
      const current = await client.query<{ id: string; created_at: Date; attempt_count: number; max_attempts: number; consumed_at: Date | null }>(
        `SELECT id, created_at, attempt_count, max_attempts, consumed_at FROM otp_challenges
          WHERE id = $1 FOR UPDATE`, [locked.rows[0].otp_challenge_id]);
      const existingChallenge = current.rows[0];
      if (!existingChallenge || existingChallenge.consumed_at) throw new GoneError("otp_expired");
      if (existingChallenge.attempt_count >= existingChallenge.max_attempts) throw new TooManyRequestsError("too_many_attempts");
      if (Date.now() - existingChallenge.created_at.getTime() < 30_000) {
        reply.header("Retry-After", "30");
        throw new TooManyRequestsError("resend_too_soon");
      }
      await assertChallengeAllowed(client, reply, app.config, { plane: "merchant", userId: pending.merchantUserId });
      await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [existingChallenge.id]);
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      await client.query(`UPDATE otp_challenges SET attempt_count = $2 WHERE id = $1`, [challenge.id, existingChallenge.attempt_count]);
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
        refunds_enabled: boolean | null;
      }>(
        `SELECT mu.email, m.id AS merchant_id, m.display_name, m.onboarding_status, m.refunds_enabled
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
          refundsEnabled: app.config.featureRefunds && row.refunds_enabled !== false,
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
