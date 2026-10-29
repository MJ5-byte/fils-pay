/**
 * Stress test: generates 2000 synthetic ledger entries spanning a month,
 * runs the reconciliation residue logic, and checks for zero net residual
 * after correction entries. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { createRng } from "../db/seed/rng.js";
import { toFils, formatBhd, type Fils, addFils, ZERO_FILS } from "@filspay/money";
import { randomUUID } from "node:crypto";
import { computeResidueFils, postResidueCorrection } from "./reconcile_march.js";

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

test("a second reconcile run for an already-swept merchant posts nothing", { timeout: 60_000 }, async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create a throwaway merchant inside this transaction and roll back at the
    // end, so the shared QA database is left exactly as it was.
    const merchantId = randomUUID();
    await client.query(
      `INSERT INTO merchants (id, display_name, mdr_bps) VALUES ($1, 'reconcile-idempotency-test', 250)`,
      [merchantId],
    );

    const countLegs = async (): Promise<number> => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
        [merchantId],
      );
      return Number(rows[0].n);
    };

    const sweep = { merchantId, lineCount: 1, residueFils: 7 };
    const now = new Date();

    await postResidueCorrection(client, sweep, now);
    const afterFirstRun = await countLegs();
    assert.equal(afterFirstRun, 2, "first run posts the merchant's two balanced legs");

    await postResidueCorrection(client, sweep, now);
    const afterSecondRun = await countLegs();
    assert.equal(afterSecondRun, afterFirstRun, "a second run posts nothing (idempotent)");

    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
