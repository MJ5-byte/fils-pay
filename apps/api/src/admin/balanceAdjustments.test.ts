/**
 * Unit tests for the two manual balance-adjustment functions, against a
 * real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { CREDIT_APPROVAL_THRESHOLD_FILS } from "./creditThreshold.js";
import {
  applyBalanceCorrection,
  adjustMerchantBalanceJournaled,
} from "./balanceAdjustments.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "balanceAdjustments.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createAdminUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Balance Adjustment Test', 'finance') RETURNING id`,
    [`balance-adj-${randomUUID()}@admin.test`],
  );
  return result.rows[0]!.id;
}

/** A merchant with an existing merchant_balances row at `startingFils`. */
async function createMerchantWithBalance(startingFils: number): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`balance-adj-merchant-${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, $2)`,
    [merchantId, startingFils],
  );
  return merchantId;
}

async function cachedBalance(merchantId: string): Promise<number> {
  const result = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(result.rows[0]!.cached_payable_fils);
}

async function ledgerRowCount(merchantId: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(result.rows[0]!.n);
}

// ------------------------------------------------ applyBalanceCorrection

test("applyBalanceCorrection posts a positive delta and leaves the cache unchanged", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(100_000);

  const result = await applyBalanceCorrection(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(50_000, { allowNegative: true }),
    reason: "statement cross-check",
  });

  assert.equal(result.cachedPayableFilsBefore, 100_000);
  assert.equal(result.cachedPayableFilsAfter, 100_000);
  assert.equal(await cachedBalance(merchantId), 100_000);

  const groups = await pool.query<{ entry_group_id: string; net: string; payable: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'credit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(Number(groups.rows[0]!.net), 0);
  assert.equal(Number(groups.rows[0]!.payable), 50_000);
});

test("applyBalanceCorrection applies a negative delta", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(80_000);

  const result = await applyBalanceCorrection(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(-30_000, { allowNegative: true }),
    reason: "duplicate credit backed out",
  });

  assert.equal(result.cachedPayableFilsBefore, 80_000);
  assert.equal(result.cachedPayableFilsAfter, 80_000);
  assert.equal(await cachedBalance(merchantId), 80_000);

  const groups = await pool.query<{ entry_group_id: string; net: string; payable: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net,
            SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'debit')::text AS payable
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(groups.rows.length, 1);
  assert.equal(Number(groups.rows[0]!.net), 0);
  assert.equal(Number(groups.rows[0]!.payable), 30_000);
});

test("applyBalanceCorrection rejects a credit above the second-approver threshold", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(0);

  await assert.rejects(
    applyBalanceCorrection(pool, {
      merchantId,
      adminUserId,
      deltaFils: toFils(CREDIT_APPROVAL_THRESHOLD_FILS + 1),
      reason: "credit requiring a second approver",
    }),
    { code: "adjustment_needs_second_approver" },
  );

  assert.equal(await ledgerRowCount(merchantId), 0);
});

test("applyBalanceCorrection writes an audit row", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(10_000);

  await applyBalanceCorrection(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(750, { allowNegative: true }),
    reason: "phone confirmation",
  });

  const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM admin_audit_log WHERE target_id = $1`,
    [merchantId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.action, "balance_adjustment");
  assert.equal(audit.rows[0]!.metadata.deltaFils, 750);
  assert.equal(audit.rows[0]!.metadata.reason, "phone confirmation");
  assert.equal(audit.rows[0]!.metadata.before, 10_000);
  assert.equal(audit.rows[0]!.metadata.after, 10_000);
  const entryGroupId = audit.rows[0]!.metadata.entryGroupId;
  assert.equal(typeof entryGroupId, "string");
  const legs = await pool.query<{ n: string; net: string }>(
    `SELECT COUNT(*)::text AS n,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE entry_group_id = $1 AND merchant_id = $2`,
    [entryGroupId, merchantId],
  );
  assert.equal(legs.rows[0]!.n, "2");
  assert.equal(legs.rows[0]!.net, "0");
});

test("applyBalanceCorrection posts for a merchant with no balance row", async () => {
  const adminUserId = await createAdminUser();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`balance-adj-no-balance-${randomUUID()}`],
  );

  const merchantId = merchant.rows[0]!.id;
  const result = await applyBalanceCorrection(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(1_000, { allowNegative: true }),
    reason: "nothing to adjust",
  });
  assert.equal(result.cachedPayableFilsBefore, 0);
  assert.equal(result.cachedPayableFilsAfter, 0);
  const payable = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  assert.equal(payable.rows[0]!.n, "1");
});

// -------------------------------------------- adjustMerchantBalanceJournaled

// these pass locally against the seed db — am 3/9
test("adjustMerchantBalanceJournaled posts a balanced group and moves the cache", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(100_000);

  const result = await adjustMerchantBalanceJournaled(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(50_000, { allowNegative: true }),
    reason: "statement cross-check",
  });

  assert.equal(result.cachedPayableFilsAfter, 150_000);
  assert.equal(await cachedBalance(merchantId), 150_000);

  const group = await pool.query<{ entry_group_id: string; net: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 GROUP BY entry_group_id`,
    [merchantId],
  );
  assert.equal(group.rows.length, 1);
  assert.equal(Number(group.rows[0]!.net), 0);
});

test("adjustMerchantBalanceJournaled credits merchant_payable for a positive delta", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(0);

  await adjustMerchantBalanceJournaled(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(4_750, { allowNegative: true }),
    reason: "owed more",
  });

  const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE merchant_id = $1 ORDER BY account_id`,
    [merchantId],
  );
  assert.deepEqual(
    legs.rows.map((r) => [r.account_id, r.direction, Number(r.amount_fils)]),
    [
      ["manual_balance_adjustment_contra", "debit", 4_750],
      ["merchant_payable", "credit", 4_750],
    ],
  );
});

test("adjustMerchantBalanceJournaled reverses leg direction for a negative delta", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(10_000);

  await adjustMerchantBalanceJournaled(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(-4_750, { allowNegative: true }),
    reason: "owed less",
  });

  const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE merchant_id = $1 ORDER BY account_id`,
    [merchantId],
  );
  assert.deepEqual(
    legs.rows.map((r) => [r.account_id, r.direction, Number(r.amount_fils)]),
    [
      ["manual_balance_adjustment_contra", "credit", 4_750],
      ["merchant_payable", "debit", 4_750],
    ],
  );
  assert.equal(await cachedBalance(merchantId), 5_250);
});

test("adjustMerchantBalanceJournaled records the entry group id on its audit row", async () => {
  const adminUserId = await createAdminUser();
  const merchantId = await createMerchantWithBalance(1_000);

  await adjustMerchantBalanceJournaled(pool, {
    merchantId,
    adminUserId,
    deltaFils: toFils(500, { allowNegative: true }),
    reason: "traceable",
  });

  const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM admin_audit_log WHERE target_id = $1`,
    [merchantId],
  );
  assert.equal(audit.rows[0]!.action, "balance_adjustment_journaled");

  const entryGroupId = audit.rows[0]!.metadata.entryGroupId;
  assert.ok(typeof entryGroupId === "string" && entryGroupId.length > 0);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE entry_group_id = $1`,
    [entryGroupId],
  );
  assert.equal(Number(legs.rows[0]!.n), 2);
});

test("adjustMerchantBalanceJournaled 404s for a merchant with no balance row", async () => {
  const adminUserId = await createAdminUser();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`balance-adj-journaled-no-balance-${randomUUID()}`],
  );

  await assert.rejects(
    adjustMerchantBalanceJournaled(pool, {
      merchantId: merchant.rows[0]!.id,
      adminUserId,
      deltaFils: toFils(1_000, { allowNegative: true }),
      reason: "nothing to adjust",
    }),
    /merchant_balance_not_found/,
  );
});
