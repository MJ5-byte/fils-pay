import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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

/**
 * A reservation is written before the Argon2 check, so a burst of correct
 * logins to one account briefly looks like a burst of failures until each one
 * verifies and clears. When the budget is full only because of rows this
 * young, wait and recount a few times instead of refusing at once: rows from
 * correct logins disappear, rows from wrong guesses stay and still lock. The
 * wait happens outside any transaction so a refused request holds no pool
 * connection or advisory lock while it sleeps.
 */
const IN_FLIGHT_MS = 2000;
const IN_FLIGHT_RETRIES = 3;
const IN_FLIGHT_RETRY_DELAY_MS = 330;

export async function reserveLoginAttempt(
  db: Pool,
  reply: FastifyReply,
  scope: "merchant" | "admin",
  key: string,
): Promise<void> {
  const accountKey = createHash("sha256").update(key).digest("hex");
  for (let attempt = 0; ; attempt++) {
    const refusal = await withTransaction(db, async (client: PoolClient) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${scope}:${accountKey}`]);
      const result = await client.query<{ failures: number; retry_after: number; newest_age_ms: number }>(
        `SELECT COUNT(*)::int AS failures,
                COALESCE(CEIL(EXTRACT(EPOCH FROM
                  (MIN(failed_at) + ($2 || ' minutes')::interval - now()))), 0)::int AS retry_after,
                COALESCE(FLOOR(EXTRACT(EPOCH FROM (now() - MAX(failed_at))) * 1000), 0)::int AS newest_age_ms
           FROM (
             SELECT failed_at FROM login_failures
              WHERE scope = $1 AND account_key = $3
                AND failed_at > now() - ($2 || ' minutes')::interval
              ORDER BY failed_at DESC
              LIMIT $4
           ) AS recent_failures`,
        [scope, LOGIN_FAILURE_WINDOW_MINUTES, accountKey, LOGIN_FAILURE_LIMIT],
      );
      const { failures, retry_after, newest_age_ms } = result.rows[0]!;
      if (failures >= LOGIN_FAILURE_LIMIT) {
        return { retryAfter: retry_after, inFlight: newest_age_ms < IN_FLIGHT_MS };
      }
      await client.query(`INSERT INTO login_failures (scope, account_key) VALUES ($1, $2)`, [scope, accountKey]);
      return null;
    });
    if (!refusal) return;
    if (!refusal.inFlight || attempt >= IN_FLIGHT_RETRIES) {
      reply.header("Retry-After", String(Math.max(1, refusal.retryAfter)));
      throw new TooManyRequestsError("too_many_login_attempts");
    }
    await sleep(IN_FLIGHT_RETRY_DELAY_MS);
  }
}

export async function clearLoginFailures(db: Pool, scope: "merchant" | "admin", key: string): Promise<void> {
  const accountKey = createHash("sha256").update(key).digest("hex");
  await db.query(`DELETE FROM login_failures WHERE scope = $1 AND account_key = $2`, [scope, accountKey]);
}
