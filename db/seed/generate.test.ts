import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { assertSeedTargetAllowed, generate } from "./generate.js";

const at = (host: string, query = "") => ({ connectionString: `postgres://u:p@${host}:5432/filspay${query}` });

test("seed truncate guard allows loopback and the compose postgres host", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "postgres"]) {
    assert.doesNotThrow(() => assertSeedTargetAllowed(at(host), {}), host);
  }
});

test("seed truncate guard refuses a remote host unless opted in", () => {
  for (const host of ["db.dilmune.example", "10.0.3.7", "proddb", "[2001:db8::1]"]) {
    assert.throws(() => assertSeedTargetAllowed(at(host), {}), /SEED_ALLOW_TRUNCATE/, host);
    assert.doesNotThrow(() => assertSeedTargetAllowed(at(host), { SEED_ALLOW_TRUNCATE: "1" }), host);
  }
});

test("seed truncate guard checks the host pg connects to, not the URL authority", () => {
  assert.throws(() => assertSeedTargetAllowed(at("localhost", "?host=db.dilmune.example"), {}), /SEED_ALLOW_TRUNCATE/);
});

test("seeded March captures have matching captured transaction_events", { timeout: 120_000 }, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point at a throwaway local database");
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  try {
    await generate(pool);
    const { rows } = await pool.query<{ missing: string; mismatched: string }>(`
      SELECT count(*) FILTER (WHERE te.id IS NULL) AS missing,
             count(*) FILTER (WHERE te.id IS NOT NULL AND (te.amount_fils <> t.captured_fils OR te.occurred_at <> t.occurred_at
               OR (te.metadata->>'feeFils')::bigint IS DISTINCT FROM COALESCE((
                 SELECT sum(amount_fils) FROM ledger_entries l
                 WHERE l.transaction_id = t.id AND l.account_id = 'platform_fee_revenue'), 0))) AS mismatched
      FROM transactions t
      LEFT JOIN transaction_events te ON te.transaction_id = t.id AND te.event_type = 'captured'
      WHERE t.reference LIKE 'alpha-retail-mar-%' AND t.captured_fils > 0`);
    assert.equal(rows[0]?.missing, "0");
    assert.equal(rows[0]?.mismatched, "0");
  } finally {
    await pool.end();
  }
});
