/**
 * refund.succeeded in the reporting read model (FP-300): counted on the
 * Asia/Bahrain business day, next to that day's captures.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyEvent.refund.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

test.after(async () => {
  await pool.end();
});

test("refund.succeeded adds to refund_count and refund_gross_fils on the Bahrain business day", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refund rollup ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  // 22:30 UTC on the 4th is 01:30 on the 5th in Bahrain.
  const createdAt = new Date("2026-01-04T22:30:00Z");

  for (const amountFils of [4000, 1500]) {
    await withTransaction(pool, (client) =>
      applyEvent(client, {
        id: 1,
        event_type: "refund.succeeded",
        aggregate_id: randomUUID(),
        payload: { merchantId, refundId: randomUUID(), amountFils, feeReversedFils: 0, newStatus: "partially_refunded" },
        created_at: createdAt,
      }),
    );
  }

  const rows = await pool.query<{ volume_date: string; refund_count: number; refund_gross_fils: string }>(
    `SELECT to_char(volume_date, 'YYYY-MM-DD') AS volume_date, refund_count, refund_gross_fils
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.volume_date, r.refund_count, Number(r.refund_gross_fils)]),
    [["2026-01-05", 2, 5500]],
  );
});
