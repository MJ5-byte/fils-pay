#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it.
 *
 * Safe to re-run: it is a dry run unless `--apply` is passed, and with
 * `--apply` it refuses to post if the March sweep has already been posted
 * (finance memo: a second run on staging doubled the gap).
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts [--apply]
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** Asia/Bahrain is a fixed UTC+3 with no DST. */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * The Asia/Bahrain calendar month as UTC instants: Bahrain midnight on the
 * 1st to Bahrain midnight on the 1st of the next month. A UTC month moves
 * three hours of activity into the wrong month at each end (ADR-0003 note,
 * HANDOVER: "use the Bahrain month, not a UTC month").
 */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
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
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

/** Marks every posting this sweep makes, so a re-run can tell it already ran. */
export const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

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

/** How many ledger rows a previous run of this sweep already posted. */
export async function countExistingSweepRows(client: Pick<Client, "query">): Promise<number> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM ledger_entries WHERE description = $1`,
    [SWEEP_DESCRIPTION],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * ADR-0002 legs: the residue never reached the scheme, so it leaves
 * card_scheme_clearing into scheme_rounding_residue, which finance clears
 * against the scheme statement. It is not the merchant's money to lose —
 * the old version debited merchant_payable, charging merchants for it.
 * Dated at the end of the corrected period (ARCHITECTURE: corrections carry
 * the effective date of the period they correct).
 */
async function postResidueCorrection(client: Client, merchant: MerchantResidue, effectiveAt: Date): Promise<void> {
  if (merchant.residueFils <= 0) return;
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'credit', $3, $4, $5),
            ($1, $2, 'scheme_rounding_residue', 'debit', $3, $4, $5)`,
    [randomUUID(), merchant.merchantId, merchant.residueFils, effectiveAt.toISOString(), SWEEP_DESCRIPTION],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }
  const apply = process.argv.includes("--apply");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const now = new Date();
  try {
    const { start, end } = monthBounds(2026, 3);
    const effectiveAt = new Date(end.getTime() - 1);

    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`mode: ${apply ? "APPLY" : "dry run (pass --apply to post)"}`);
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window (Asia/Bahrain): ${start.toISOString()} .. ${end.toISOString()}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // Serialise concurrent runs, then refuse if a previous run already posted.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [SWEEP_DESCRIPTION]);
      const existing = await countExistingSweepRows(client);
      if (existing > 0) {
        await client.query("ROLLBACK");
        console.log(`already posted: ${existing} ledger row(s) carry this sweep's description. Nothing done.`);
        return;
      }

      const rows = await fetchResidueRows(client, 2026, 3);
      const merchantResidues = groupByMerchant(rows);
      const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);

      for (const merchant of merchantResidues) {
        if (apply) await postResidueCorrection(client, merchant, effectiveAt);
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)`,
        );
      }

      if (apply) {
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
      }
      console.log("---");
      console.log(`total lines matched: ${rows.length}`);
      console.log(`total residue: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
      console.log("");
      console.log(apply ? "reconciliation applied successfully" : "dry run: nothing was posted");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
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
