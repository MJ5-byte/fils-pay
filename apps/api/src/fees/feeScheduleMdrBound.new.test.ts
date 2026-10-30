/**
 * BHA-118: fee_schedules.mdr_bps must reject an absurd rate. The write path
 * is the database constraint itself (no application route inserts a fee
 * schedule), so this asserts the constraint against a real, migrated
 * Postgres, the same setup as feeSchedule.test.ts. A bad rate entering the
 * table is a silent break: nothing rejects it at write time and it only
 * surfaces later as a wrong settlement fee.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "feeScheduleMdrBound.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

test("fee_schedules rejects an MDR rate above the 10000 bps cap", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`MDR Bound Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]?.id;
  assert.ok(merchantId, "merchant insert returned no id");

  await assert.rejects(
    () =>
      pool.query(`INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, $2, $3)`, [
        merchantId,
        25000,
        "2026-01-01T00:00:00Z",
      ]),
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "code" in err, "expected a pg error");
      assert.equal((err as { code?: string }).code, "23514", "expected a check-constraint violation");
      return true;
    },
  );
});
