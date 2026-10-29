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

/** One atomic statement: flip every abandoned active hold to 'expired' in a
 *  single UPDATE, keyed on status and expiry so a concurrent capture/void
 *  that released the hold is never touched (no SELECT-then-UPDATE TOCTOU).
 *  Holds are never deleted — history stays. */
export function buildExpiredHoldsUpdate(): string {
  return `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`;
}

/**
 * Expires every hold that is still 'active' and past expires_at. Captured
 * or released holds are never touched, and a night with nothing expired
 * changes no rows.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(buildExpiredHoldsUpdate());
    console.log(`expire_holds: expired ${result.rowCount ?? 0} abandoned hold(s)`);
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
