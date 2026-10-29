#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at forever — nothing else in the platform
 * ever deletes a holds row (authorize.ts inserts one, capture.ts/void.ts
 * release one; nothing sweeps one). Run once a night from cron/the host's
 * own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildDelete } from "./lib/sqlFilter.js";

/** Holds that outlived their authorization window without being captured
 *  or released — the candidate set for tonight's cleanup. */
export async function fetchExpiredHoldIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rows.map((r) => r.id);
}

export function buildExpiredHoldsDelete(expiredIds: string[]): { text: string; values: unknown[] } {
  // Re-check the expiry predicate at delete time. A hold captured or released
  // between fetchExpiredHoldIds and this delete is no longer active, so the
  // id list alone would still remove it; the status/expires_at guard keeps the
  // delete to holds that are still abandoned when the row is actually removed.
  const { text, values } = buildDelete("holds", { id: expiredIds });
  return { text: `${text} AND status = 'active' AND expires_at < now()`, values };
}

/**
 * Deletes only holds that are still 'active' and past expires_at. Captured
 * or released holds are never touched. When nothing has expired the id list
 * is empty, so the delete carries a false predicate (`WHERE 1 = 0`) and
 * removes zero rows rather than every row.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // FH: SELECT then DELETE, a hold could be captured in between. claude: "negligible window, fine."
    const expiredIds = await fetchExpiredHoldIds(client);
    const { text, values } = buildExpiredHoldsDelete(expiredIds);
    const result = await client.query(text, values);
    console.log(
      `expire_holds: matched ${expiredIds.length} abandoned hold(s), deleted ${result.rowCount ?? 0} row(s)`,
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
