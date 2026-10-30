/**
 * A merchant can only cancel its own payment links (finance memo: "I
 * cancelled merchant B's payment link from merchant A's dashboard").
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { cancelPaymentLink } from "./cancel.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("cancel.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Cancel ${label} ${randomUUID().slice(0, 8)}`],
  );
  return result.rows[0]!.id;
}

async function createLink(merchantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 1000, now() + interval '1 day', 'merchant_api_key', $3) RETURNING id`,
    [merchantId, `plink_${randomUUID()}`, randomUUID()],
  );
  return result.rows[0]!.id;
}

async function linkStatus(id: string): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [id]);
  return result.rows[0]!.status;
}

test("another merchant cannot cancel a link and gets not_found", async () => {
  const merchantA = await createMerchant("A");
  const merchantB = await createMerchant("B");
  const bLink = await createLink(merchantB);

  assert.deepEqual(await cancelPaymentLink(pool, { id: bLink, merchantId: merchantA }), { outcome: "not_found" });
  assert.equal(await linkStatus(bLink), "active");
});

test("the owning merchant can cancel its own link", async () => {
  const merchant = await createMerchant("owner");
  const link = await createLink(merchant);

  assert.deepEqual(await cancelPaymentLink(pool, { id: link, merchantId: merchant }), { outcome: "canceled" });
  assert.equal(await linkStatus(link), "canceled");
});
