/**
 * DB-backed tests for API-key verification. Requires DATABASE_URL to point at
 * a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { issueApiKeyInTx } from "./issue.js";
import { verifyApiKey } from "./verify.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "verify.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

test.after(async () => {
  await pool.end();
});

async function createMerchantWithKey(label: string): Promise<{ merchantId: string; rawKey: string }> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Api Key Verify ${label} ${suffix.slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchantId, `${label}-${suffix}@verify.test`],
  );
  const issued = await withTransaction(pool, (client) =>
    issueApiKeyInTx(client, { nodeEnv: "test" }, { merchantId, createdBy: user.rows[0]!.id }),
  );
  return { merchantId, rawKey: issued.rawKey };
}

test("verifyApiKey resolves a key of an active merchant", async () => {
  const { merchantId, rawKey } = await createMerchantWithKey("active");

  const context = await verifyApiKey(pool, rawKey);
  assert.equal(context?.merchantId, merchantId);
});

test("verifyApiKey returns null once the merchant is suspended or closed", async () => {
  for (const status of ["suspended", "closed"]) {
    const { merchantId, rawKey } = await createMerchantWithKey(status);
    await pool.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [merchantId, status]);

    assert.equal(await verifyApiKey(pool, rawKey), null, `a ${status} merchant's key must not resolve`);
  }
});
