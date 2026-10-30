/**
 * Impersonation is view-only whatever the admin's own role (ARCH §8,
 * HANDOVER), and a disabled admin's grant stops resolving.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { lookupImpersonationGrant, startImpersonation } from "./impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("impersonation.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

test.after(async () => {
  await pool.end();
});

async function createAdmin(role: "support" | "finance" | "super_admin"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused-in-these-tests', $2, $3) RETURNING id`,
    [`imp-${role}-${randomUUID()}@impersonation.test`, `Imp ${role}`, role],
  );
  return result.rows[0]!.id;
}

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Impersonation ${randomUUID().slice(0, 8)}`],
  );
  return result.rows[0]!.id;
}

for (const role of ["support", "finance", "super_admin"] as const) {
  test(`a ${role} admin's grant resolves to merchant role 'support'`, async () => {
    const started = await startImpersonation(pool, {
      adminUserId: await createAdmin(role),
      merchantId: await createMerchant(),
      ttlMinutes: 15,
    });

    const grant = await lookupImpersonationGrant(pool, started.rawToken);
    assert.ok(grant);
    assert.equal(grant.merchantRole, "support");
  });
}

test("a disabled admin's grant no longer resolves", async () => {
  const adminUserId = await createAdmin("super_admin");
  const started = await startImpersonation(pool, {
    adminUserId,
    merchantId: await createMerchant(),
    ttlMinutes: 15,
  });
  await pool.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [adminUserId]);

  assert.equal(await lookupImpersonationGrant(pool, started.rawToken), null);
});
