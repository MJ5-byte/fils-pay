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
      { merchantId, amount: "5" },
    ],
  });

  assert.equal(result.rowCount, 2);
  assert.equal(result.totalPostedFils, 9750);

  const rows = await getAdjustmentImportRows(pool, result.importId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.rowNumber, 1);
  assert.equal(rows[0]!.rawAmountText, "4.75");
  assert.equal(rows[0]!.parsedAmountFils, 4750);
  assert.equal(rows[0]!.reason, "statement correction");
  assert.equal(rows[1]!.rawAmountText, "5");
  assert.equal(rows[1]!.parsedAmountFils, 5000);
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

test("applyAdjustmentImport leaves the merchant balance cache untouched", async () => {
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
  assert.equal(balance.rows.length, 0, "posting does not create a cache row before close");
  const groups = await pool.query<{ entry_group_id: string; net: string; payable: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'credit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 2);
  assert.deepEqual(groups.rows.map((row) => Number(row.payable)).sort((a, b) => a - b), [1000, 4000]);
  for (const group of groups.rows) assert.equal(Number(group.net), 0);
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

// BHA-191: a retried upload of the same file must not pay every merchant in it again.
test("applyAdjustmentImport posts a resent file once and replays the first result", async () => {
  const adminUserId = await createAdminUser();
  const merchantA = await createMerchant();
  const merchantB = await createMerchant();
  const rows = [
    { merchantId: merchantA, amount: "4.750", reason: "statement correction" },
    { merchantId: merchantB, amount: "-1.000" },
  ];

  const first = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "march.csv", rows });
  const resent = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "march (1).csv", rows });

  assert.equal(first.alreadyApplied, false);
  assert.equal(resent.alreadyApplied, true);
  assert.deepEqual(resent, { ...first, alreadyApplied: true });
  const posted = await pool.query<{ merchant_id: string; n: string }>(
    `SELECT merchant_id, COUNT(*)::text AS n FROM adjustment_import_rows
      WHERE merchant_id = ANY($1::uuid[]) GROUP BY merchant_id`,
    [[merchantA, merchantB]],
  );
  assert.equal(posted.rowCount, 2);
  for (const row of posted.rows) {
    assert.equal(row.n, "1", `merchant ${row.merchant_id} was posted more than once`);
  }
  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = ANY($1::uuid[])`,
    [[merchantA, merchantB]],
  );
  assert.equal(legs.rows[0]!.n, "4", "one balanced pair per row, once");
});

test("applyAdjustmentImport posts an identical file again only with a repeat upload id", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchant();
  const rows = [{ merchantId, amount: "2.500", reason: "monthly correction" }];

  const first = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "monthly.csv", rows });
  const resent = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "monthly.csv", rows });
  assert.equal(resent.alreadyApplied, true);
  assert.equal(resent.importId, first.importId);

  const repeatUploadId = randomUUID();
  const repeat = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "monthly.csv", rows, repeatUploadId });
  assert.equal(repeat.alreadyApplied, false);
  assert.notEqual(repeat.importId, first.importId);

  const repeatResent = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "monthly.csv", rows, repeatUploadId });
  assert.equal(repeatResent.alreadyApplied, true);
  assert.equal(repeatResent.importId, repeat.importId);

  const posted = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM adjustment_import_rows WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(posted.rows[0]!.n, "2");
  const audit = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM admin_audit_log WHERE action = 'adjustment_import_applied' AND target_id = $1`,
    [repeat.importId],
  );
  assert.equal(audit.rows[0]!.n, "1");
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

  // The list spans all imports and the database clock can step backwards, so make these newest.
  // GREATEST leaves their timestamps alone when the clock behaved.
  await pool.query(
    `UPDATE adjustment_imports
        SET created_at = GREATEST(created_at, (SELECT max(created_at) FROM adjustment_imports WHERE id <> ALL($2::uuid[])) + interval '1 microsecond')
      WHERE id = $1`,
    [first.importId, [first.importId, second.importId]],
  );
  await pool.query(
    `UPDATE adjustment_imports
        SET created_at = GREATEST(created_at, (SELECT max(created_at) FROM adjustment_imports WHERE id <> $1) + interval '1 microsecond')
      WHERE id = $1`,
    [second.importId],
  );

  const page = await listAdjustmentImports(pool, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.id, second.importId);
  const appliedAt = page.items[0]!.appliedAt;
  assert.equal(new Date(appliedAt).toISOString(), appliedAt, "appliedAt is an ISO instant, not Postgres text");
  assert.ok(page.nextCursor);

  const next = await listAdjustmentImports(pool, { limit: 1, cursor: page.nextCursor });
  assert.equal(next.items[0]!.id, first.importId);
});

test("getAdjustmentImportRows returns an empty list for an unknown import", async () => {
  const rows = await getAdjustmentImportRows(pool, randomUUID());
  assert.deepEqual(rows, []);
});
