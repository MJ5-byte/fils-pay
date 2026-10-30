/**
 * Tests for the report scope check, against a real, migrated Postgres
 * (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { resolveReportMerchantId } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("scope.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Report Scope Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** A marketplace parent with one split child, plus an unrelated merchant. */
async function seedSplit() {
  const parent = await createMerchant();
  const child = await createMerchant();
  const outsider = await createMerchant();
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 10000)`,
    [parent, child],
  );
  return { parent, child, outsider };
}

test("a merchant with no requested merchant reports on itself", async () => {
  const { outsider } = await seedSplit();

  assert.equal(await resolveReportMerchantId(pool, outsider), outsider);
});

test("a parent can scope its report to its own split child", async () => {
  const { parent, child } = await seedSplit();

  assert.equal(await resolveReportMerchantId(pool, parent, child), child);
});

test("a merchant cannot scope its report to another merchant's split child", async () => {
  const { child, outsider } = await seedSplit();

  assert.equal(await resolveReportMerchantId(pool, outsider, child), outsider);
});

test("a split child cannot scope its report to its parent", async () => {
  const { parent, child } = await seedSplit();

  assert.equal(await resolveReportMerchantId(pool, child, parent), child);
});
