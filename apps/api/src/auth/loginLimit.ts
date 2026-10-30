import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FastifyReply } from "fastify";
import { withTransaction } from "../db/withTransaction.js";
import { TooManyRequestsError } from "../lib/errors.js";

/**
 * Unbounded password guessing spends Argon2 CPU on every guess. Reserve at most
 * 5 failures per 15 minutes before the lookup and hash, keyed on the typed
 * identifier so an unknown account has the same budget and lockout response.
 * Locked attempts add no rows, so they cannot extend their own cooldown.
 */
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MINUTES = 15;

export async function reserveLoginAttempt(
  db: Pool,
  reply: FastifyReply,
  scope: "merchant" | "admin",
  key: string,
): Promise<void> {
  const accountKey = createHash("sha256").update(key).digest("hex");
  await withTransaction(db, async (client: PoolClient) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${scope}:${accountKey}`]);
    const result = await client.query<{ failures: number; retry_after: number }>(
      `SELECT COUNT(*)::int AS failures,
              COALESCE(CEIL(EXTRACT(EPOCH FROM
                (MIN(failed_at) + ($2 || ' minutes')::interval - now()))), 0)::int AS retry_after
         FROM (
           SELECT failed_at FROM login_failures
            WHERE scope = $1 AND account_key = $3
              AND failed_at > now() - ($2 || ' minutes')::interval
            ORDER BY failed_at DESC
            LIMIT $4
         ) AS recent_failures`,
      [scope, LOGIN_FAILURE_WINDOW_MINUTES, accountKey, LOGIN_FAILURE_LIMIT],
    );
    const { failures, retry_after } = result.rows[0]!;
    if (failures >= LOGIN_FAILURE_LIMIT) {
      reply.header("Retry-After", String(Math.max(1, retry_after)));
      throw new TooManyRequestsError("too_many_login_attempts");
    }
    await client.query(`INSERT INTO login_failures (scope, account_key) VALUES ($1, $2)`, [scope, accountKey]);
  });
}

export async function clearLoginFailures(db: Pool, scope: "merchant" | "admin", key: string): Promise<void> {
  const accountKey = createHash("sha256").update(key).digest("hex");
  await db.query(`DELETE FROM login_failures WHERE scope = $1 AND account_key = $2`, [scope, accountKey]);
}
