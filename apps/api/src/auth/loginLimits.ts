import type { FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { TooManyRequestsError } from "../lib/errors.js";
import { withTransaction } from "../db/withTransaction.js";

/**
 * Login limits for the merchant and admin planes, counted in Postgres so
 * every API instance sees the same numbers. Over the last
 * `loginWindowMinutes`:
 *
 * - failed password attempts per account from one client IP
 *   (`loginMaxFailuresPerAccount`). Counting per account *and* IP means a
 *   stranger who knows an email can only lock it for their own address; the
 *   owner on another network can still log in;
 * - failed password attempts per client IP (`loginMaxFailuresPerIp`). Only
 *   failures count, so many users behind one proxy aren't throttled by each
 *   other's successful logins;
 * - OTP challenges issued per user, by login and by resend together
 *   (`otpMaxChallengesPerUser`). Without this, every correct password or
 *   resend handed out a fresh OTP attempt budget, so the OTP attempt limit
 *   could be bypassed by logging in again.
 *
 * Over a limit the request gets 429 `too_many_attempts` with Retry-After,
 * before any password is hashed. A refused attempt is not recorded, so
 * knocking on a locked account doesn't keep it locked.
 */

export type LoginPlane = "merchant" | "admin";

type LimitsConfig = Pick<
  Config,
  "loginWindowMinutes" | "loginMaxFailuresPerAccount" | "loginMaxFailuresPerIp" | "otpMaxChallengesPerUser"
>;

export function merchantAccountKey(merchantId: string, email: string): string {
  return `${merchantId}:${email.trim().toLowerCase()}`;
}

export function adminAccountKey(email: string): string {
  return email.trim().toLowerCase();
}

function tooManyAttempts(reply: FastifyReply, config: LimitsConfig): TooManyRequestsError {
  reply.header("retry-after", String(config.loginWindowMinutes * 60));
  return new TooManyRequestsError("too_many_attempts", "Too many attempts. Try again later.");
}

/**
 * Checks limits and reserves this login attempt as a failure under an IP
 * lock. Counting the attempt before the password
 * is verified means parallel guesses can't all pass the check at once.
 *
 * Returns the attempt's id: call `clearLoginAttempt` once the password has
 * been verified, so a correct password never counts as a failure.
 */
export async function beginLoginAttempt(
  pool: Pool,
  reply: FastifyReply,
  config: LimitsConfig,
  input: { plane: LoginPlane; accountKey: string; ip: string },
): Promise<string> {
  const attemptId = await withTransaction(pool, async (client) => {
    // Serialize admission per plane and IP, before counting or inserting.
    // Independent replicas cannot all admit the same remaining guess.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`login:${input.plane}:${input.ip}`]);
    const counts = await client.query<{ account_failures: number; ip_failures: number }>(
      `SELECT
         count(*) FILTER (WHERE account_key = $2)::int AS account_failures,
         count(*)::int AS ip_failures
       FROM login_failures WHERE plane = $1 AND ip = $3
         AND created_at > now() - make_interval(mins => $4::int)`,
      [input.plane, input.accountKey, input.ip, config.loginWindowMinutes],
    );
    const row = counts.rows[0]!;
    if (row.account_failures >= config.loginMaxFailuresPerAccount || row.ip_failures >= config.loginMaxFailuresPerIp) {
      throw tooManyAttempts(reply, config);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO login_failures (plane, account_key, ip) VALUES ($1, $2, $3) RETURNING id`,
      [input.plane, input.accountKey, input.ip],
    );
    return inserted.rows[0]!.id;
  });

  // Bounded clean-up of rows long past any window.
  await pool.query(
    `DELETE FROM login_failures
      WHERE id IN (SELECT id FROM login_failures WHERE created_at < now() - interval '1 day' LIMIT 100)`,
  );

  return attemptId;
}

/** The password was right: this attempt is not a failure. */
export async function clearLoginAttempt(pool: Pool, attemptId: string): Promise<void> {
  await pool.query(`DELETE FROM login_failures WHERE id = $1`, [attemptId]);
}

/**
 * Refuses a new OTP challenge once the user has been issued
 * `otpMaxChallengesPerUser` in the window. Must run inside the transaction
 * that issues the challenge: the advisory lock serialises concurrent logins
 * and resends for one user, so they can't all pass the count together.
 */
export async function assertChallengeAllowed(
  client: PoolClient,
  reply: FastifyReply,
  config: LimitsConfig,
  input: { plane: LoginPlane; userId: string },
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `otp-challenges:${input.plane}:${input.userId}`,
  ]);
  const sql =
    input.plane === "merchant"
      ? `SELECT count(*)::int AS n FROM otp_challenges
          WHERE merchant_user_id = $1 AND created_at > now() - make_interval(mins => $2::int)`
      : `SELECT count(*)::int AS n FROM admin_otp_challenges
          WHERE admin_user_id = $1 AND created_at > now() - make_interval(mins => $2::int)`;
  const result = await client.query<{ n: number }>(sql, [input.userId, config.loginWindowMinutes]);
  if (result.rows[0]!.n >= config.otpMaxChallengesPerUser) {
    throw tooManyAttempts(reply, config);
  }
}
