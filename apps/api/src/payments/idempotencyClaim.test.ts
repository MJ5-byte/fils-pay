/**
 * Concurrency test for claimIdempotencyKey against a real, migrated Postgres
 * (no DB mocking), same style as discountAdjustment.test.ts. Covers BHA-146:
 * two concurrent retries of a FAILED idempotency key must not both execute the
 * money operation.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { claimIdempotencyKey, completeIdempotencyKey, type IdempotencyOutcome } from "./idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "idempotencyClaim.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

// BHA-146: with the failed-row read unlocked, two concurrent retries both read
// 'failed' before either updates, so each caller runs the money op once, a
// duplicate charge or credit. The fix locks the row (SELECT ... FOR UPDATE),
// so the second retry blocks behind the first and, once the first commits its
// completed claim, replays the stored result instead of executing.
//
// The two claims are launched in the same tick so their statements advance in
// lockstep: both INSERT ... ON CONFLICT (no-op against the idle committed row,
// so neither blocks the other there), then both read, then both update. That
// ordering is exactly the race; the only serialization that can save it is the
// row lock the fix adds.
test("concurrent retries of a failed key let exactly one proceed; the other replays", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps)
     VALUES ($1, 275, 0) RETURNING id`,
    [`Idempotency Retry ${randomUUID()}`],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const scope = {
    merchantId,
    endpoint: "transactions.capture",
    key: randomUUID(),
    requestHash: "a".repeat(64),
  };

  // A prior attempt that failed transiently, so a retry is legitimate.
  await pool.query(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status, attempt_count)
     VALUES ($1, $2, $3, $4, 'failed', 1)`,
    [scope.merchantId, scope.endpoint, scope.key, scope.requestHash],
  );

  const storedBody = { ok: true, ref: randomUUID() };

  async function retry(client: PoolClient): Promise<{ outcome: IdempotencyOutcome; body: unknown }> {
    await client.query("BEGIN");
    try {
      const claim = await claimIdempotencyKey(client, scope);
      // Only a proceeding retry runs the money op and completes the claim.
      if (claim.outcome === "fresh" || claim.outcome === "retry_after_failure") {
        await completeIdempotencyKey(client, claim.row.id, { statusCode: 200, body: storedBody });
      }
      await client.query("COMMIT");
      return { outcome: claim.outcome, body: claim.row.responseBody };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const [a, b] = await Promise.all([retry(first), retry(second)]);
    const outcomes = [a.outcome, b.outcome];

    const proceeded = outcomes.filter((o) => o === "fresh" || o === "retry_after_failure").length;
    const replayed = outcomes.filter((o) => o === "replay").length;

    assert.equal(proceeded, 1, `exactly one retry may run the money op, got outcomes ${outcomes.join(", ")}`);
    assert.equal(replayed, 1, `the other retry must replay the stored result, got outcomes ${outcomes.join(", ")}`);

    // The replaying retry returns the first retry's stored body verbatim.
    const replay = [a, b].find((r) => r.outcome === "replay");
    assert.deepEqual(replay?.body, storedBody);
  } finally {
    first.release();
    second.release();
  }
});
