/**
 * BHA-103 regression: `getRecentLedgerActivity` must count a boundary business
 * day in exactly one window. `to` is exclusive (same convention as
 * `parseDateRange`/`getVolumes`/`getTopLinks`), so a transaction on date D in
 * Asia/Bahrain terms belongs to the window that starts on D, never also to the
 * window that ends on D. The old `BETWEEN ... AND` (inclusive both ends) put
 * that boundary day in both adjacent windows, double-counting it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getRecentLedgerActivity } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "recentLedgerActivityBoundary.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

/** A balanced two-leg ledger group. The balance trigger (ADR-0007) rejects
 *  any group that doesn't net to zero. */
async function insertLedgerPair(merchantId: string, occurredAt: string): Promise<void> {
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'debit',  $3, $4, 'boundary'),
            ($1, $2, 'merchant_payable',     'credit', $3, $4, 'boundary')`,
    [randomUUID(), merchantId, 4_500, occurredAt],
  );
}

test("getRecentLedgerActivity: a boundary business day is counted in exactly one window", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`BHA-103 Boundary ${randomUUID()}`, 250],
  );
  const merchantId = merchantResult.rows[0]!.id;

  // 2026-02-01 08:00 Asia/Bahrain (UTC+3) = 2026-02-01T05:00:00Z, so the
  // business day is 2026-02-01 in Bahrain terms.
  await insertLedgerPair(merchantId, "2026-02-01T05:00:00Z");

  // Window that ENDS on the boundary day: [2026-01-01, 2026-02-01).
  // `to` is exclusive, so the 2026-02-01 activity must not appear here.
  const ending = await getRecentLedgerActivity(pool, {
    merchantId,
    from: "2026-01-01",
    to: "2026-02-01",
  });
  assert.equal(
    ending.points.length,
    0,
    "the boundary day must be excluded from the window that ends on it (`to` is exclusive)",
  );

  // Window that STARTS on the boundary day: [2026-02-01, 2026-03-01).
  // The two legs of the boundary-day group must appear here, exactly once.
  const starting = await getRecentLedgerActivity(pool, {
    merchantId,
    from: "2026-02-01",
    to: "2026-03-01",
  });
  assert.equal(
    starting.points.length,
    2,
    "the boundary day belongs to the window that starts on it, counted once",
  );
});

test("getRecentLedgerActivity: more than 200 rows are all reachable by following nextCursor (BHA-106)", async () => {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`BHA-106 Paging ${randomUUID()}`, 250],
  );
  const merchantId = merchantResult.rows[0]!.id;

  // 103 pairs = 206 rows; the pairs share a timestamp, so the id tie-break matters.
  for (let i = 0; i < 103; i++) {
    await insertLedgerPair(merchantId, new Date(Date.UTC(2026, 2, 1, 5, 0, i)).toISOString());
  }

  const window = { merchantId, from: "2026-03-01", to: "2026-04-01" };
  const seen = new Set<string>();
  let cursor: string | null | undefined;
  let pages = 0;
  do {
    const page = await getRecentLedgerActivity(pool, { ...window, cursor });
    assert.ok(page.points.length <= 200, "a page never exceeds 200 rows");
    for (const point of page.points) seen.add(point.id);
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);

  assert.equal(seen.size, 206, "every row is returned exactly once across the pages");
  assert.equal(pages, 2);
});

test("getRecentLedgerActivity: a malformed cursor is rejected, not read as page one (BHA-106)", async () => {
  await assert.rejects(
    getRecentLedgerActivity(pool, {
      merchantId: randomUUID(),
      from: "2026-03-01",
      to: "2026-04-01",
      cursor: "not-a-cursor",
    }),
    { code: "invalid_cursor" },
  );
});
