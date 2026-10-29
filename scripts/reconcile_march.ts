#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** Asia/Bahrain is UTC+3 with no daylight saving — a fixed offset, never a
 *  naive UTC month. Mirrors the Asia/Bahrain handling in settlement windows. */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  // The whole [start, end) interval is the fixed Asia/Bahrain calendar month:
  // it begins at YYYY-M-01T00:00+03:00 (21:00Z the previous day) and ends at
  // the first instant of the next month in Bahrain.
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

/** The sweep description the idempotency guard keys on. Keep it stable for a
 *  given month so a re-run really is a no-op. */
const sweepDescription = "March 2026 scheme rounding residue sweep — manual recon per finance";

export async function postResidueCorrection(
  client: Client,
  merchant: MerchantResidue,
  now: Date,
): Promise<void> {
  if (merchant.residueFils <= 0) return;
  const entryGroupId = randomUUID();
  // Idempotency guard (B5): only post when this merchant has no prior posting
  // for this sweep. Both legs share the same guard and entry_group_id, so the
  // balanced pair lands whole on the first run and a second run inserts
  // nothing. The old comment claimed entry_group_id deduped re-runs, but the
  // group id is a fresh UUID every run and ledger_entries has no constraint
  // on it — the dedupe never worked.
  const guardNotPosted = `NOT EXISTS (
      SELECT 1 FROM ledger_entries WHERE merchant_id = $2 AND description = $5
    )`;
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     SELECT $1::uuid, $2::uuid, 'merchant_payable', 'debit', $3::bigint, $4::timestamptz, $5 WHERE ${guardNotPosted}
     UNION ALL
     SELECT $1::uuid, $2::uuid, 'scheme_rounding_residue', 'credit', $3::bigint, $4::timestamptz, $5 WHERE ${guardNotPosted}`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, now.toISOString(), sweepDescription],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version
  const now = new Date();

  const { start, end } = monthBounds(2026, 3);
  const bahrainDate = (d: Date) =>
    new Date(d.getTime() + BAHRAIN_OFFSET_MS).toISOString().slice(0, 10);
  console.log("=== March 2026 reconciliation sweep ===");
  console.log(`run at: ${now.toISOString()}`);
  console.log(`window: ${bahrainDate(start)} .. ${bahrainDate(end)} (Asia/Bahrain, UTC+3)`);
  console.log("");

  let rows: ResidueRow[] = [];
  let totalResidueFils = 0;
  try {
    // The SELECT and the guarded INSERT share one transaction so the
    // NOT EXISTS guard reads the same snapshot it writes against (B5).
    await client.query("BEGIN");
    try {
      rows = await fetchResidueRows(client, 2026, 3);
      const merchantResidues = groupByMerchant(rows);
      totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);
      for (const merchant of merchantResidues) {
        await postResidueCorrection(client, merchant, now);
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
