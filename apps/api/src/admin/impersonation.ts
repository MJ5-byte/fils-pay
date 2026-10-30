import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { NotFoundError } from "../lib/errors.js";

/** rawToken is returned exactly once; only its sha256 is stored. */
export interface StartedImpersonation {
  grantId: string;
  merchantId: string;
  rawToken: string;
  expiresAt: Date;
}

/** Issues a "view as merchant" grant. */
export async function startImpersonation(
  pool: Pool,
  input: { adminUserId: string; merchantId: string; ttlMinutes: number },
): Promise<StartedImpersonation> {
  const rawToken = randomToken(32);
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.adminUserId, input.merchantId, tokenHash, expiresAt],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("startImpersonation: insert into admin_impersonation_grants returned no row");
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "impersonation_start",
      targetType: "merchant",
      targetId: input.merchantId,
      metadata: { grantId: row.id, expiresAt: expiresAt.toISOString() },
    });

    return { grantId: row.id, merchantId: input.merchantId, rawToken, expiresAt };
  });
}

/** Ends a grant. */
export async function endImpersonation(
  pool: Pool,
  input: { adminUserId: string; grantId: string },
): Promise<{ grantId: string; merchantId: string }> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ id: string; merchant_id: string }>(
      `UPDATE admin_impersonation_grants
          SET ended_at = now()
        WHERE id = $1 AND admin_user_id = $2 AND ended_at IS NULL
      RETURNING id, merchant_id`,
      [input.grantId, input.adminUserId],
    );
    const row = updated.rows[0];
    if (!row) {
      throw new NotFoundError("impersonation_grant_not_found");
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "impersonation_end",
      targetType: "merchant",
      targetId: row.merchant_id,
      metadata: { grantId: row.id },
    });

    return { grantId: row.id, merchantId: row.merchant_id };
  });
}

/** The merchant plane's own role vocabulary (`merchant_users.role`). */
export type ImpersonationMerchantRole = "owner" | "finance" | "support";

/** `admin_users.role` (migration 0031). */
type AdminUserRole = "support" | "finance" | "super_admin";

/** Maps the admin's role to the merchant-plane role used during impersonation.
 *  Always 'support' (ARCH §8, HANDOVER): a grant is view-only whatever the
 *  admin's own standing. */
const MERCHANT_ROLE_FOR_ADMIN_ROLE: Record<AdminUserRole, ImpersonationMerchantRole> = {
  support: "support",
  finance: "support",
  super_admin: "support",
};

/** @property merchantRole Always "support" (ARCH §8): a grant is view-only. */
export interface ImpersonationGrantLookup {
  grantId: string;
  adminUserId: string;
  merchantId: string;
  merchantRole: ImpersonationMerchantRole;
}

/**
 * The sole definition of "this request carries a live impersonation grant",
 * called only from `requireMerchantAuth`. Same predicate discipline as every
 * other session-shaped lookup here: never a bare token match.
 */
// No admin-disable trigger revokes grants, so the admin's status is checked
// here, matching adminAuth/sessions.ts.
export async function lookupImpersonationGrant(
  pool: Pool,
  rawToken: string,
): Promise<ImpersonationGrantLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  const result = await pool.query<{
    id: string;
    admin_user_id: string;
    merchant_id: string;
    admin_role: AdminUserRole;
  }>(
    `SELECT g.id, g.admin_user_id, g.merchant_id, au.role AS admin_role
       FROM admin_impersonation_grants g
       JOIN admin_users au ON au.id = g.admin_user_id
      WHERE g.token_hash = $1
        AND g.revoked_at IS NULL
        AND g.ended_at IS NULL
        AND g.expires_at > now()
        AND au.status = 'active'`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    grantId: row.id,
    adminUserId: row.admin_user_id,
    merchantId: row.merchant_id,
    merchantRole: MERCHANT_ROLE_FOR_ADMIN_ROLE[row.admin_role],
  };
}
