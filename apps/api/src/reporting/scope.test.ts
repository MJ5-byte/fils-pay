/**
 * Tests for resolveReportMerchantId's split-parent scoping: a requested
 * merchant is only readable when the caller is that merchant's split
 * parent — anyone else requesting it falls back to their own id. BUG4:
 * the predicate used to check only `child_merchant_id` membership, so any
 * caller could read any split child's report. Requires DATABASE_URL to
 * point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { resolveReportMerchantId } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("scope.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Scope Test ${label} ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function addSplitChild(parentId: string, childId: string): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 5000)`,
    [parentId, childId],
  );
}

test("no requestedMerchantId resolves to the caller's own id", async () => {
  const callerId = await createMerchant("no-request");
  assert.equal(await resolveReportMerchantId(pool, callerId), callerId);
});

test("requesting the caller's own id resolves to the caller", async () => {
  const callerId = await createMerchant("self-request");
  assert.equal(await resolveReportMerchantId(pool, callerId, callerId), callerId);
});

test("a requested merchant that is the caller's split child resolves to the child", async () => {
  const callerId = await createMerchant("parent");
  const childId = await createMerchant("own-child");
  await addSplitChild(callerId, childId);

  assert.equal(await resolveReportMerchantId(pool, callerId, childId), childId);
});

test("a requested merchant that is someone else's split child falls back to the caller (BUG4)", async () => {
  const callerId = await createMerchant("caller");
  const otherParentId = await createMerchant("other-parent");
  const childId = await createMerchant("someone-elses-child");
  await addSplitChild(otherParentId, childId);

  assert.equal(await resolveReportMerchantId(pool, callerId, childId), callerId);
});

test("a requested merchant that is no one's split child falls back to the caller", async () => {
  const callerId = await createMerchant("standalone-caller");
  const unrelatedId = await createMerchant("not-a-child");

  assert.equal(await resolveReportMerchantId(pool, callerId, unrelatedId), callerId);
});
