/**
 * Stress test: generates 2000 synthetic ledger entries spanning a month,
 * runs the reconciliation residue logic, and checks for zero net residual
 * after correction entries. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { createRng } from "../db/seed/rng.js";
import { toFils, formatBhd, type Fils, addFils, ZERO_FILS } from "@filspay/money";
import { computeResidueFils, sweepResidue } from "./reconcile_march.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "reconcile_march.integration.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const ENTRY_COUNT = 2000;
const MARCH_START = new Date("2026-03-01T00:00:00Z");
const MARCH_END = new Date("2026-04-01T00:00:00Z");
const MARCH_SPAN_MS = MARCH_END.getTime() - MARCH_START.getTime();
const DAYS_IN_MARCH = 31;

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

test.after(async () => {
  await pool.end();
});

test("reconciliation stress: 2000 ledger entries with zero net residual", { timeout: 120_000 }, async () => {
  const rng = createRng(314159);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TEMP TABLE stress_captures (
        id SERIAL PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        captured_fils BIGINT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        residue_fils BIGINT NOT NULL
      ) ON COMMIT DROP
    `);

    const merchantId = "stress-test-merchant-00000000";
    const dailyTotals = new Map<number, { captures: number; residueFils: number; grossFils: number }>();

    for (let day = 1; day <= DAYS_IN_MARCH; day++) {
      dailyTotals.set(day, { captures: 0, residueFils: 0, grossFils: 0 });
    }

    console.log(`generating ${ENTRY_COUNT} synthetic capture entries...`);

    let totalResidue: Fils = ZERO_FILS;
    let totalGross: Fils = ZERO_FILS;

    for (let i = 0; i < ENTRY_COUNT; i++) {
      const offsetMs = Math.floor(rng.next() * MARCH_SPAN_MS);
      const occurredAt = new Date(MARCH_START.getTime() + offsetMs);
      const day = occurredAt.getUTCDate();

      const capturedFils = toFils(rng.int(10, 999_999));
      const residueFils = computeResidueFils(capturedFils);

      await client.query(
        `INSERT INTO stress_captures (merchant_id, captured_fils, occurred_at, residue_fils)
         VALUES ($1, $2, $3, $4)`,
        [merchantId, capturedFils, occurredAt.toISOString(), residueFils],
      );

      totalResidue = addFils(totalResidue, toFils(residueFils));
      totalGross = addFils(totalGross, capturedFils);

      const dayStats = dailyTotals.get(day)!;
      dayStats.captures += 1;
      dayStats.residueFils += residueFils;
      dayStats.grossFils += capturedFils;

      if ((i + 1) % 200 === 0) {
        console.log(`  inserted ${i + 1}/${ENTRY_COUNT} entries...`);
      }
    }

    console.log("\ndaily totals:");
    for (let day = 1; day <= DAYS_IN_MARCH; day++) {
      const stats = dailyTotals.get(day)!;
      if (stats.captures > 0) {
        console.log(
          `  March ${String(day).padStart(2, "0")}: ${stats.captures} captures, ` +
          `gross ${formatBhd(toFils(stats.grossFils))}, ` +
          `residue ${stats.residueFils} fils`,
        );
      }
    }

    console.log(`\ntotal gross: ${formatBhd(totalGross)} BD`);
    console.log(`total residue: ${formatBhd(totalResidue)} BD (${totalResidue} fils)`);

    const dbResidue = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(residue_fils), 0)::text AS total FROM stress_captures`,
    );
    const dbTotal = Number(dbResidue.rows[0]?.total ?? "0");

    console.log(`db-computed residue: ${dbTotal} fils`);

    assert.equal(dbTotal, Number(totalResidue), "db residue should match in-memory calculation");

    const modResidue = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(captured_fils % 10), 0)::text AS total FROM stress_captures`,
    );
    const modTotal = Number(modResidue.rows[0]?.total ?? "0");

    console.log(`db mod-10 residue: ${modTotal} fils`);
    assert.equal(modTotal, dbTotal, "mod-10 residue should match stored residue");

    const floorResidue = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(captured_fils - (captured_fils / 10) * 10), 0)::text AS total FROM stress_captures`,
    );
    const floorTotal = Number(floorResidue.rows[0]?.total ?? "0");

    console.log(`db floor-formula residue: ${floorTotal} fils`);
    assert.equal(floorTotal, dbTotal, "floor-formula residue should match mod-10 residue");

    console.log("\nreconciliation stress test passed: all three residue methods agree");

    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

function idOf(rows: { id: string }[]): string {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("INSERT ... RETURNING id returned no row");
  return id;
}

const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";
const SWEPT_AT = new Date("2036-04-02T09:00:00Z");

/** Runs body in a transaction that is always rolled back, with a fresh merchant. */
async function withMerchant(body: (client: PoolClient, merchantId: string) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const merchant = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name) VALUES ('reconcile_march test') RETURNING id`,
    );
    await body(client, idOf(merchant.rows));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function closedBatch(client: PoolClient, merchantId: string, batchDate: string): Promise<string> {
  const batch = await client.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, closed_at)
     VALUES ($1, $2, 'closed', $2::date + interval '1 day') RETURNING id`,
    [merchantId, batchDate],
  );
  return idOf(batch.rows);
}

async function capturedTransaction(
  client: PoolClient,
  merchantId: string,
  amountFils: number,
  occurredAt: string,
): Promise<string> {
  const txn = await client.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', $2, $2, 'acq_reconcile_march_test', $3) RETURNING id`,
    [merchantId, amountFils, occurredAt],
  );
  return idOf(txn.rows);
}

/** One batched capture event of grossFils and the export line CloseBatch would
 *  write for it, carrying exportedFils (the gross truncated, unless a test
 *  needs a line that disagrees with its events). */
async function exportLine(
  client: PoolClient,
  batchId: string,
  transactionId: string,
  grossFils: number,
  occurredAt: string,
  exportedFils = Math.floor(grossFils / 10) * 10,
): Promise<void> {
  await client.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, settlement_batch_id)
     VALUES ($1, 'partially_captured', $2, 'system', $3, $4)`,
    [transactionId, grossFils, occurredAt, batchId],
  );
  await client.query(
    `INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
     VALUES ($1, $2, $3, 1)`,
    [batchId, transactionId, exportedFils],
  );
}

interface SweepLeg {
  group: string;
  transactionId: string | null;
  account: string;
  direction: string;
  fils: number;
}

async function sweepLegs(client: PoolClient, merchantId: string): Promise<SweepLeg[]> {
  const result = await client.query<{
    entry_group_id: string;
    transaction_id: string | null;
    account_id: string;
    direction: string;
    amount_fils: string;
  }>(
    `SELECT entry_group_id, transaction_id, account_id, direction, amount_fils FROM ledger_entries
      WHERE merchant_id = $1 AND description = $2
      ORDER BY settlement_batch_id, account_id`,
    [merchantId, SWEEP_DESCRIPTION],
  );
  return result.rows.map((r) => ({
    group: r.entry_group_id,
    transactionId: r.transaction_id,
    account: r.account_id,
    direction: r.direction,
    fils: Number(r.amount_fils),
  }));
}

async function postLegacySweep(client: PoolClient, merchantId: string, fils: number, reversed: boolean): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ('00000000-0000-0000-0000-000000000326', $1, 'merchant_payable', 'debit', $2, now(), $3),
            ('00000000-0000-0000-0000-000000000326', $1, 'scheme_rounding_residue', 'credit', $2, now(), $3)`,
    [merchantId, fils, SWEEP_DESCRIPTION],
  );
  if (!reversed) return;
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ('00000000-0000-0000-0000-000000000327', $1, 'merchant_payable', 'credit', $2, now(), $3),
            ('00000000-0000-0000-0000-000000000327', $1, 'scheme_rounding_residue', 'debit', $2, now(), $3)`,
    [merchantId, fils, SWEEP_DESCRIPTION],
  );
}

test("a second sweep of the same month posts nothing", async () => {
  await withMerchant(async (client, merchantId) => {
    // Two captures of 4.505 BD on different days: each export line loses
    // 5 fils, while the cumulative 9.010 BD captured is a multiple of 10.
    const split = await capturedTransaction(client, merchantId, 9010, "2036-03-10T09:00:00Z");
    await exportLine(client, await closedBatch(client, merchantId, "2036-03-10"), split, 4505, "2036-03-10T09:00:00Z");
    await exportLine(client, await closedBatch(client, merchantId, "2036-03-11"), split, 4505, "2036-03-11T09:00:00Z");

    // A batch CloseBatch already journalled its 7 fils of residue for.
    const journalledBatch = await closedBatch(client, merchantId, "2036-03-12");
    const journalled = await capturedTransaction(client, merchantId, 1007, "2036-03-12T09:00:00Z");
    await exportLine(client, journalledBatch, journalled, 1007, "2036-03-12T09:00:00Z");
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ('00000000-0000-0000-0000-000000003612', $1, $2, $3, 'card_scheme_clearing',    'credit', 7, now(), 'scheme rounding residue'),
         ('00000000-0000-0000-0000-000000003612', $1, $2, $3, 'scheme_rounding_residue', 'debit',  7, now(), 'scheme rounding residue')`,
      [merchantId, journalled, journalledBatch],
    );

    await sweepResidue(client, 2036, 3, SWEPT_AT);
    const afterFirst = await sweepLegs(client, merchantId);
    assert.deepEqual(
      afterFirst.map(({ transactionId, account, direction, fils }) => ({ transactionId, account, direction, fils })),
      [
        { transactionId: split, account: "card_scheme_clearing", direction: "credit", fils: 5 },
        { transactionId: split, account: "scheme_rounding_residue", direction: "debit", fils: 5 },
        { transactionId: split, account: "card_scheme_clearing", direction: "credit", fils: 5 },
        { transactionId: split, account: "scheme_rounding_residue", direction: "debit", fils: 5 },
      ],
    );
    assert.equal(new Set(afterFirst.map((l) => l.group)).size, 2, "one journal group per export line");

    await sweepResidue(client, 2036, 3, SWEPT_AT);
    assert.deepEqual(await sweepLegs(client, merchantId), afterFirst, "the second run must not post again");

    // The ledger's balance trigger is deferred to commit; run it now.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
});

test("the sweep refuses to post over a run of the script before BHA-20", async () => {
  await withMerchant(async (client, merchantId) => {
    await postLegacySweep(client, merchantId, 70, false);
    await assert.rejects(sweepResidue(client, 2036, 3, SWEPT_AT), /earlier version of this sweep/);
  });
});

test("an old run that finance has reversed no longer blocks the sweep", async () => {
  await withMerchant(async (client, merchantId) => {
    await postLegacySweep(client, merchantId, 70, true);
    await sweepResidue(client, 2036, 3, SWEPT_AT);
  });
});

test("a line whose residue is outside 0-9 fils aborts the whole sweep", async () => {
  await withMerchant(async (client, merchantId) => {
    const fine = await capturedTransaction(client, merchantId, 1005, "2036-03-10T09:00:00Z");
    await exportLine(client, await closedBatch(client, merchantId, "2036-03-10"), fine, 1005, "2036-03-10T09:00:00Z");
    const broken = await capturedTransaction(client, merchantId, 1025, "2036-03-11T09:00:00Z");
    await exportLine(client, await closedBatch(client, merchantId, "2036-03-11"), broken, 1025, "2036-03-11T09:00:00Z", 1000);

    await assert.rejects(sweepResidue(client, 2036, 3, SWEPT_AT), /outside 0-9 fils/);
    assert.deepEqual(await sweepLegs(client, merchantId), [], "nothing is posted, not even the line that was fine");
  });
});
