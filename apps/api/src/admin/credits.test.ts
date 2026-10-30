/**
 * DB-backed tests for the credit service itself: what it journals, what it
 * does to the cached balance, which instant the legs are anchored to, and
 * what happens when two approvers race. Requires DATABASE_URL to point at a
 * real, migrated Postgres (run `npm run migrate` first).
 *
 * These go through the exported service rather than the routes on purpose —
 * the ledger invariants below are properties of the posting itself, not of
 * any particular HTTP surface.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  approveCreditRequest,
  createCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "./credits.js";
import { AppError } from "../lib/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "credits.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });

test.after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------- fixtures

async function createMerchant(label: string, mdrBps = 250): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Credit Svc ${label} ${randomUUID()}`, mdrBps],
  );
  return result.rows[0]!.id;
}

/** Real operators are distinct people with distinct names; each fixture gets
 *  its own so these tests never depend on one another. */
async function createAdmin(label: string): Promise<{ id: string; displayName: string }> {
  const suffix = randomUUID();
  const displayName = `${label} ${suffix.slice(0, 8)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused-in-these-tests', $2, 'finance') RETURNING id`,
    [`${label}-${suffix}@admin.test`, displayName],
  );
  return { id: result.rows[0]!.id, displayName };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ledgerLegs(entryGroupId: string) {
  const result = await pool.query<{
    account_id: string;
    direction: string;
    amount_fils: string;
    occurred_at: Date;
    description: string | null;
  }>(
    `SELECT account_id, direction, amount_fils::text AS amount_fils, occurred_at, description
       FROM ledger_entries WHERE entry_group_id = $1 ORDER BY id`,
    [entryGroupId],
  );
  return result.rows;
}

function netOf(legs: Array<{ direction: string; amount_fils: string }>): number {
  return legs.reduce(
    (net, leg) => net + (leg.direction === "debit" ? Number(leg.amount_fils) : -Number(leg.amount_fils)),
    0,
  );
}

async function cachedPayable(merchantId: string): Promise<number | null> {
  const result = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils::text AS cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  return row ? Number(row.cached_payable_fils) : null;
}

// ------------------------------------------------------- ledger invariants

test("a fee-less credit posts one balanced entry group of exactly two legs", async () => {
  const merchantId = await createMerchant("noreversal");
  const admin = await createAdmin("noreversal");

  const record = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 12_345, reasonCode: "goodwill", effectiveDate: todayIso() },
  });
  assert.equal(record.status, "posted");
  assert.equal(record.feeReversalFils, 0);
  assert.equal(record.postedAmountFils, 12_345);

  const legs = await ledgerLegs(record.ledgerEntryGroupId!);
  assert.equal(legs.length, 2, "no fee leg pair when the reversal is zero");
  assert.equal(netOf(legs), 0, "debits must equal credits");
  assert.deepEqual(
    legs.map((l) => `${l.account_id}:${l.direction}:${l.amount_fils}`).sort(),
    ["merchant_credit_contra:debit:12345", "merchant_payable:credit:12345"],
  );
});

test("a credit with a fee reversal posts four legs in ONE group that still nets to zero", async () => {
  const merchantId = await createMerchant("reversal", 250);
  const admin = await createAdmin("reversal");

  const record = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: {
      baseAmountFils: 20_000,
      reasonCode: "dispute_resolution",
      effectiveDate: todayIso(),
      reverseFee: true,
    },
  });
  assert.equal(record.feeReversalFils, 500, "20.000 BD @ 250 bps");
  assert.equal(record.postedAmountFils, 20_500);

  const legs = await ledgerLegs(record.ledgerEntryGroupId!);
  assert.equal(legs.length, 4);
  assert.equal(netOf(legs), 0, "0007's deferred constraint trigger requires this at commit");
  assert.deepEqual(
    legs.map((l) => `${l.account_id}:${l.direction}:${l.amount_fils}`).sort(),
    [
      "merchant_credit_contra:debit:20000",
      "merchant_payable:credit:20000",
      "merchant_payable:credit:500",
      "platform_fee_revenue:debit:500",
    ].sort(),
  );
});

// BHA-189: the cache holds closed, unpaid batch nets, and the next CloseBatch
// carries the credit into its net, so posting must not add it a second time.
test("posting a credit journals base + reversal and leaves merchant_balances to the batch close", async () => {
  const merchantId = await createMerchant("balance", 275);
  const admin = await createAdmin("balance");
  assert.equal(await cachedPayable(merchantId), null, "no cache row before the first credit");

  const first = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: {
      baseAmountFils: 30_000,
      reasonCode: "correction",
      effectiveDate: todayIso(),
      reverseFee: true,
    },
  });
  assert.equal(first.feeReversalFils, 825, "30.000 BD @ 275 bps");

  const second = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: todayIso() },
  });
  assert.equal(second.postedAmountFils, 1_000);
  assert.equal(await cachedPayable(merchantId), null, "the batch close, not the posting, moves the cache");

  const ledgerNet = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  assert.equal(Number(ledgerNet.rows[0]!.net), 31_825, "both credits are owed on merchant_payable");
});

// MK: this test is the spec for backdated credits. finance sign-off 12.01.2026
test("both legs occur at Asia/Bahrain midnight of the effective date, not of 'now'", async () => {
  const merchantId = await createMerchant("occurred", 250);
  const admin = await createAdmin("occurred");
  // Relative to today, so this test says the same thing however old the repo
  // gets — and never becomes a date the platform would refuse.
  const effectiveDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

  const record = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 4_000, reasonCode: "goodwill", effectiveDate, reverseFee: true },
  });
  assert.equal(record.effectiveDate, effectiveDate);

  // Bahrain is UTC+03 year-round, so midnight local is 21:00 UTC the day
  // before. Asserted as an instant, not as a rendered local string.
  const expected = new Date(`${effectiveDate}T00:00:00+03:00`).getTime();
  const legs = await ledgerLegs(record.ledgerEntryGroupId!);
  assert.equal(legs.length, 4);
  for (const leg of legs) {
    assert.equal(leg.occurred_at.getTime(), expected, leg.description ?? "");
  }
});

// --------------------------------------------------------- maker-checker

// FH: ran this 20x, always exactly one winner
test("two concurrent approvals of one pending request resolve to exactly one winner", async () => {
  const merchantId = await createMerchant("race", 250);
  const maker = await createAdmin("race-maker");
  const checkerA = await createAdmin("race-checker-a");
  const checkerB = await createAdmin("race-checker-b");

  const pending = await createCreditRequest(pool, {
    merchantId,
    adminUserId: maker.id,
    body: { baseAmountFils: 90_000, reasonCode: "goodwill", effectiveDate: todayIso() },
  });
  assert.equal(pending.status, "pending_approval");

  const results = await Promise.allSettled([
    approveCreditRequest(pool, {
      creditRequestId: pending.id,
      approver: { adminUserId: checkerA.id, displayName: checkerA.displayName },
    }),
    approveCreditRequest(pool, {
      creditRequestId: pending.id,
      approver: { adminUserId: checkerB.id, displayName: checkerB.displayName },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one approval may win the FOR UPDATE lock");
  assert.equal(rejected.length, 1);
  const err = (rejected[0] as PromiseRejectedResult).reason as unknown;
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, "credit_request_not_pending");

  // One approval means one entry group and one balance movement, not two.
  const groups = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT entry_group_id)::text AS count FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(groups.rows[0]!.count, "1");
});

test("rejecting a pending credit journals nothing and closes it to approval", async () => {
  const merchantId = await createMerchant("rejected");
  const maker = await createAdmin("rejected-maker");
  const checker = await createAdmin("rejected-checker");

  const pending = await createCreditRequest(pool, {
    merchantId,
    adminUserId: maker.id,
    body: { baseAmountFils: 75_000, reasonCode: "goodwill", effectiveDate: todayIso() },
  });
  const rejected = await rejectCreditRequest(pool, {
    creditRequestId: pending.id,
    adminUserId: checker.id,
    reason: "duplicate of an earlier credit",
  });
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.rejectedAt);
  assert.equal(rejected.ledgerEntryGroupId, null);

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0);
  assert.equal(await cachedPayable(merchantId), null);

  await assert.rejects(
    approveCreditRequest(pool, {
      creditRequestId: pending.id,
      approver: { adminUserId: checker.id, displayName: checker.displayName },
    }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "credit_request_not_pending");
      return true;
    },
  );
});

test("an unknown credit request id is a 404 from approve and reject alike", async () => {
  const checker = await createAdmin("missing");
  for (const call of [
    () =>
      approveCreditRequest(pool, {
        creditRequestId: randomUUID(),
        approver: { adminUserId: checker.id, displayName: checker.displayName },
      }),
    () => rejectCreditRequest(pool, { creditRequestId: randomUUID(), adminUserId: checker.id }),
  ]) {
    await assert.rejects(call(), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "credit_request_not_found");
      return true;
    });
  }
});

test("creating a credit against an unknown merchant journals nothing and 404s", async () => {
  const admin = await createAdmin("nomerchant");
  await assert.rejects(
    createCreditRequest(pool, {
      merchantId: randomUUID(),
      adminUserId: admin.id,
      body: { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: todayIso() },
    }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "merchant_not_found");
      return true;
    },
  );
});

test("the list projection carries the posted total and both operators' names", async () => {
  const merchantId = await createMerchant("projection", 250);
  const maker = await createAdmin("projection-maker");
  const checker = await createAdmin("projection-checker");

  const pending = await createCreditRequest(pool, {
    merchantId,
    adminUserId: maker.id,
    body: {
      baseAmountFils: 80_000,
      reasonCode: "dispute_resolution",
      effectiveDate: todayIso(),
      reverseFee: true,
    },
  });
  await approveCreditRequest(pool, {
    creditRequestId: pending.id,
    approver: { adminUserId: checker.id, displayName: checker.displayName },
  });

  const page = await listCreditRequests(pool, { merchantId });
  assert.equal(page.items.length, 1);
  const item = page.items[0]!;
  assert.equal(item.requestedByDisplayName, maker.displayName);
  assert.equal(item.approvedByDisplayName, checker.displayName);
  assert.equal(item.baseAmountFils, 80_000);
  assert.equal(item.feeReversalFils, 2_000);
  assert.equal(item.postedAmountFils, 82_000, "postedAmountFils is base + reversal, always");
  assert.equal(item.status, "posted");
});
