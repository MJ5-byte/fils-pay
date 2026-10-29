/**
 * Unit tests for the CSV adjustment importer, against a real, migrated
 * Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  applyAdjustmentImport,
  getAdjustmentImportRows,
  listAdjustmentImports,
} from "./adjustmentImport.js";

// these just skip when DATABASE_URL isnt set, so ci is green either way — am
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adjustmentImport.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createAdminUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Adjustment Import Test', 'finance') RETURNING id`,
    [`adj-import-${randomUUID()}@admin.test`],
  );
  return result.rows[0]!.id;
}

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`adj-import-merchant-${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

test("applyAdjustmentImport records the batch and its rows", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  const result = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "corrections.csv",
    rows: [
      { merchantId, amount: "4.75", reason: "statement correction" },
      { merchantId, amount: "1.25" },
    ],
  });

  assert.equal(result.rowCount, 2);
  assert.equal(result.totalPostedFils, 6000);

  const rows = await getAdjustmentImportRows(pool, result.importId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.rowNumber, 1);
  assert.equal(rows[0]!.rawAmountText, "4.75");
  assert.equal(rows[0]!.parsedAmountFils, 4750);
  assert.equal(rows[0]!.reason, "statement correction");
  assert.equal(rows[1]!.rawAmountText, "1.25");
  assert.equal(rows[1]!.parsedAmountFils, 1250);
  assert.equal(rows[1]!.reason, null);
});

test("applyAdjustmentImport preserves the raw CSV text verbatim", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  const result = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "raw.csv",
    rows: [{ merchantId, amount: "4.750" }],
  });

  const rows = await getAdjustmentImportRows(pool, result.importId);
  assert.equal(rows[0]!.rawAmountText, "4.750");
});

test("applyAdjustmentImport posts a balanced ledger group per row", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "balanced.csv",
    rows: [{ merchantId, amount: "10.00" }],
  });

  const groups = await pool.query<{ entry_group_id: string; net: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(Number(groups.rows[0]!.net), 0);
});

test("applyAdjustmentImport reverses leg direction for a negative amount", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "negative.csv",
    rows: [{ merchantId, amount: "-3.50" }],
  });

  const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE merchant_id = $1 ORDER BY account_id`,
    [merchantId],
  );
  assert.deepEqual(
    legs.rows.map((r) => [r.account_id, r.direction, Number(r.amount_fils)]),
    [
      ["manual_balance_adjustment_contra", "credit", 3500],
      ["merchant_payable", "debit", 3500],
    ],
  );
});

test("applyAdjustmentImport updates the merchant balance cache", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "cache.csv",
    rows: [
      { merchantId, amount: "4.00" },
      { merchantId, amount: "1.00" },
    ],
  });

  const balance = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(balance.rows[0]!.cached_payable_fils), 5000);
});

test("applyAdjustmentImport links each row to its ledger group", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  const result = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "linked.csv",
    rows: [{ merchantId, amount: "2.00" }],
  });

  const rows = await getAdjustmentImportRows(pool, result.importId);
  const groupId = rows[0]!.ledgerEntryGroupId;
  assert.ok(groupId);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE entry_group_id = $1`,
    [groupId],
  );
  assert.equal(Number(legs.rows[0]!.n), 2);
});

test("applyAdjustmentImport writes one audit row for the batch", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  const result = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "audited.csv",
    rows: [{ merchantId, amount: "6.00" }],
  });

  const audit = await pool.query<{ action: string; target_type: string; metadata: Record<string, unknown> }>(
    `SELECT action, target_type, metadata FROM admin_audit_log WHERE target_id = $1`,
    [result.importId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.action, "adjustment_import_applied");
  assert.equal(audit.rows[0]!.target_type, "adjustment_import");
  assert.equal(audit.rows[0]!.metadata.rowCount, 1);
  assert.equal(audit.rows[0]!.metadata.originalFilename, "audited.csv");
});

test("applyAdjustmentImport rejects an empty row list", async () => {
  const adminUserId = await createAdminUser();
  await assert.rejects(
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "empty.csv", rows: [] }),
    /at least one row/,
  );
});

test("applyAdjustmentImport rolls the whole batch back when one row fails", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  await assert.rejects(
    applyAdjustmentImport(pool, {
      adminUserId,
      originalFilename: "partial.csv",
      rows: [
        { merchantId, amount: "5.00" },
        { merchantId, amount: "not-a-number" },
      ],
    }),
    /could not parse amount/,
  );

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(legs.rows[0]!.n), 0, "the first row's posting must roll back with the batch");
});

test("listAdjustmentImports returns newest first and paginates", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();

  const first = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "first.csv",
    rows: [{ merchantId, amount: "1.00" }],
  });
  const second = await applyAdjustmentImport(pool, {
    adminUserId,
    originalFilename: "second.csv",
    rows: [{ merchantId, amount: "2.00" }],
  });

  const page = await listAdjustmentImports(pool, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.id, second.importId);
  assert.ok(page.nextCursor);

  const next = await listAdjustmentImports(pool, { limit: 1, cursor: page.nextCursor });
  assert.equal(next.items[0]!.id, first.importId);
});

test("getAdjustmentImportRows returns an empty list for an unknown import", async () => {
  const rows = await getAdjustmentImportRows(pool, randomUUID());
  assert.deepEqual(rows, []);
});
