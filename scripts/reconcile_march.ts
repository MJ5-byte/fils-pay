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
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client, type ClientBase } from "pg";
import { formatBhd, toFils } from "@filspay/money";

export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

export interface LineResidue {
  lineId: string;
  merchantId: string;
  batchId: string;
  transactionId: string | null;
  residueFils: number;
}

/**
 * Every scheme export line with a residue, as ADR-0002 defines it: the line's
 * gross (the capture events CloseBatch summed into it) minus the amount_fils
 * the scheme received. Per line, not from the transaction's cumulative
 * captured_fils, where two partial captures' losses can cancel. Batches are
 * picked by batch_date in the month. batch_date is the Asia/Bahrain business
 * day CloseBatch windows (BusinessDayWindow), so this is the Bahrain business
 * month and a batch is swept whole or not at all. Batches that already carry
 * residue legs, from CloseBatch at close or from an earlier sweep, are skipped.
 */
async function fetchResidueLines(client: ClientBase, year: number, month: number): Promise<LineResidue[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{
    line_id: string;
    merchant_id: string;
    batch_id: string;
    transaction_id: string | null;
    residue_fils: string;
  }>(
    `SELECT sel.id AS line_id, sb.merchant_id, sb.id AS batch_id, sel.transaction_id,
            g.gross_fils - sel.amount_fils AS residue_fils
       FROM settlement_batches sb
       JOIN scheme_export_lines sel ON sel.settlement_batch_id = sb.id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(te.amount_fils), 0) AS gross_fils
           FROM transaction_events te
          WHERE te.settlement_batch_id = sel.settlement_batch_id
            AND te.transaction_id = sel.transaction_id
            AND te.event_type IN ('captured', 'partially_captured')
       ) g
      WHERE sb.batch_date >= $1::date AND sb.batch_date < $2::date
        AND g.gross_fils <> sel.amount_fils
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le
           WHERE le.settlement_batch_id = sb.id
             AND le.account_id = 'scheme_rounding_residue'
        )
      ORDER BY sb.merchant_id, sb.batch_date, sel.line_sequence`,
    [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)],
  );
  return result.rows.map((r) => ({
    lineId: r.line_id,
    merchantId: r.merchant_id,
    batchId: r.batch_id,
    transactionId: r.transaction_id,
    residueFils: Number(r.residue_fils),
  }));
}

/** Truncating to 10 fils loses 0 to 9 fils per line. Anything else means the
 *  line and its capture events disagree, and a human has to look first. */
function assertResiduesInRange(lines: LineResidue[]): void {
  const bad = lines.filter((l) => l.residueFils < 0 || l.residueFils > 9);
  if (bad.length === 0) return;
  const sample = bad
    .slice(0, 5)
    .map((l) => `line ${l.lineId} in batch ${l.batchId}: ${l.residueFils} fils`)
    .join("; ");
  throw new Error(
    `reconcile_march: ${bad.length} scheme export line(s) have a residue outside 0-9 fils, nothing was posted (${sample})`,
  );
}

/** Each line's journal group, derived from the month and the line alone. */
export function residueGroupId(year: number, month: number, lineId: string): string {
  const hex = createHash("sha256")
    .update(`reconcile-residue:${year}-${String(month).padStart(2, "0")}:${lineId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

/** ADR-0002's legs, one balanced group per line, carrying the line's merchant,
 *  transaction and batch the way CloseBatch posts them at close. */
async function postResidueLines(
  client: ClientBase,
  year: number,
  month: number,
  lines: LineResidue[],
  now: Date,
): Promise<void> {
  if (lines.length === 0) return;
  await client.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
     SELECT u.group_id, u.merchant_id, u.transaction_id, u.batch_id, legs.account_id, legs.direction, u.residue_fils, $6, $7
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::bigint[])
            AS u(group_id, merchant_id, transaction_id, batch_id, residue_fils)
      CROSS JOIN (VALUES ('card_scheme_clearing', 'credit'), ('scheme_rounding_residue', 'debit'))
            AS legs(account_id, direction)`,
    [
      lines.map((l) => residueGroupId(year, month, l.lineId)),
      lines.map((l) => l.merchantId),
      lines.map((l) => l.transactionId),
      lines.map((l) => l.batchId),
      lines.map((l) => l.residueFils),
      now.toISOString(),
      SWEEP_DESCRIPTION,
    ],
  );
}

export interface SweepResult {
  lines: LineResidue[];
  totalResidueFils: number;
}

/**
 * Posts the residue of every line not yet journalled; a second run finds the
 * first run's legs on those batches and posts nothing. Must run inside the
 * caller's READ COMMITTED transaction: the advisory lock is held until it
 * ends, so a run started at the same time waits and then re-selects.
 */
export async function sweepResidue(client: ClientBase, year: number, month: number, now: Date): Promise<SweepResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('reconcile_march'))");
  // The script before BHA-20 posted merchant_payable legs under random
  // groups. Until finance reverses them (a reversal nets them to zero),
  // posting again would sweep the month twice.
  const legacy = await client.query<{ net_fils: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net_fils
       FROM ledger_entries
      WHERE description = $1 AND account_id = 'merchant_payable'`,
    [SWEEP_DESCRIPTION],
  );
  const legacyNetFils = Number(legacy.rows[0]?.net_fils ?? "0");
  if (legacyNetFils !== 0) {
    throw new Error(
      `reconcile_march: an earlier version of this sweep left ${legacyNetFils} fils net on merchant_payable; finance must reverse it before this runs`,
    );
  }
  const lines = await fetchResidueLines(client, year, month);
  assertResiduesInRange(lines);
  await postResidueLines(client, year, month, lines, now);
  const totalResidueFils = lines.reduce((sum, l) => sum + l.residueFils, 0);
  return { lines, totalResidueFils };
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

  try {
    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window: ${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}`);
    console.log("");

    await client.query("BEGIN");
    let result: SweepResult;
    try {
      result = await sweepResidue(client, 2026, 3, now);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    for (const line of result.lines) {
      console.log(
        `merchant ${line.merchantId} batch ${line.batchId} line ${line.lineId}: residue ${formatBhd(toFils(line.residueFils))} BD (${line.residueFils} fils)`,
      );
    }
    console.log("---");
    console.log(`total lines matched: ${result.lines.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(result.totalResidueFils))} BD (${result.totalResidueFils} fils)`);
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
