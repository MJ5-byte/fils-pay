#!/usr/bin/env -S npx tsx
/**
 * Unscheduled janitor: marks active holds expired once their authorization
 * window ends. The rows stay because capture.ts reads expired holds to
 * refuse captures after expiry. Nothing schedules this script today.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildWhere } from "./lib/sqlFilter.js";

/** Holds whose authorization window has ended without being captured
 *  or released, so their status needs to reflect expiry. */
export async function fetchExpiredHoldIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE status = 'active' AND expires_at <= now()`,
  );
  return result.rows.map((r) => r.id);
}

export function buildExpiredHoldsUpdate(expiredIds: string[]): { text: string; values: unknown[] } {
  // Re-check status and expiry at update time so a hold captured or released
  // after fetchExpiredHoldIds keeps its new status instead of being expired.
  const { clause, values } = buildWhere({ id: expiredIds });
  return { text: `UPDATE holds SET status = 'expired' ${clause} AND status = 'active' AND expires_at <= now()`, values };
}

/**
 * Marks holds expired only while they are still 'active' and their expiry
 * has been reached. Captured or released holds are never touched. An empty
 * id list carries a false predicate (`WHERE 1 = 0`) so it touches zero rows.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expiredIds = await fetchExpiredHoldIds(client);
    const { text, values } = buildExpiredHoldsUpdate(expiredIds);
    const result = await client.query(text, values);
    console.log(
      `expire_holds: matched ${expiredIds.length} abandoned hold(s), marked ${result.rowCount ?? 0} row(s) expired`,
    );
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
