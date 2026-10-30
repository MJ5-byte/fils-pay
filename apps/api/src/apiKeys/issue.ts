import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { sha256Hex } from "../lib/crypto.js";

/** @property rawKey Shown to the caller once; only key_hash is stored. */
export interface IssuedApiKey {
  id: string;
  prefix: string;
  rawKey: string;
  createdAt: Date;
}

/**
 * Exactly one of `createdBy` (a merchant_users id) and `createdByAdminUserId`
 * (an admin_users id) must be set — the same XOR the database itself
 * enforces via `api_keys_created_by_actor_check` (0037). Checked here too so
 * a programming mistake surfaces as a clear error rather than as a raw
 * constraint-violation message.
 */
/** @property rotatedFromKeyId When set, that key is revoked in the same transaction. */
export interface IssueApiKeyInput {
  merchantId: string;
  createdBy?: string;
  createdByAdminUserId?: string;
  label?: string;
  /** Set only by the admin rotation path — points at the key this one
   *  replaced, making a rotation self-documenting without a second table. */
  rotatedFromKeyId?: string;
}

/**
 * Issues a fresh API key inside the caller's open transaction, so issuance
 * can be made atomic with whatever else must happen alongside it (the admin
 * rotation path revokes the old key and writes an audit row in the same
 * transaction as this insert). `rawKey` appears in the return value and
 * nowhere else, ever — no endpoint, log line, or later re-fetch can recover
 * it. Only its sha256 hash and a display-safe prefix are persisted.
 */
// YA: raw key returned once, only its sha256 stored, randomness from lib/crypto. good
// the stored prefix leaks entropy of the raw key? — am
// MK: a few chars of a long random key. meh. leave it
export async function issueApiKeyInTx(
  client: PoolClient,
  config: Pick<Config, "nodeEnv">,
  input: IssueApiKeyInput,
): Promise<IssuedApiKey> {
  const hasMerchantActor = input.createdBy !== undefined && input.createdBy !== null;
  const hasAdminActor = input.createdByAdminUserId !== undefined && input.createdByAdminUserId !== null;
  if (hasMerchantActor === hasAdminActor) {
    throw new Error(
      "issueApiKeyInTx: exactly one of createdBy (merchant user) or createdByAdminUserId must be provided",
    );
  }

  const environment = config.nodeEnv === "production" ? "live" : "test";
  const rawKey = `fp_${environment}_${randomBytes(24).toString("base64url")}`;
  const keyPrefix = rawKey.slice(0, 16);
  const keyHash = sha256Hex(rawKey);

  const result = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (merchant_id, key_prefix, key_hash, label, created_by, created_by_admin_user_id, rotated_from_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      input.merchantId,
      keyPrefix,
      keyHash,
      input.label ?? null,
      input.createdBy ?? null,
      input.createdByAdminUserId ?? null,
      input.rotatedFromKeyId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("issueApiKeyInTx: insert into api_keys returned no row");
  }

  return { id: row.id, prefix: keyPrefix, rawKey, createdAt: row.created_at };
}

/**
 * Pool-based wrapper for the merchant-owner call site (and the seed), which
 * has nothing to co-transact with the insert.
 */
export async function issueApiKey(
  pool: Pool,
  config: Pick<Config, "nodeEnv">,
  input: IssueApiKeyInput,
): Promise<IssuedApiKey> {
  return withTransaction(pool, async (client) => issueApiKeyInTx(client, config, input));
}

/**
 * Never carries key_hash.
 */
export interface ApiKeySummary {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function listApiKeys(
  pool: Pool,
  merchantId: string,
  limit?: number,
): Promise<ApiKeySummary[]> {
  const boundedLimit = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
  const result = await pool.query<{
    id: string;
    key_prefix: string;
    label: string | null;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, key_prefix, label, created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [merchantId, boundedLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    prefix: row.key_prefix,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

/** Always merchant-scoped by construction — revoking another merchant's key
 *  by guessing an ID must be impossible, not merely disallowed by convention. */
// FH: admin rotation (admin/apiKeys.ts) should call this — it doesn't
// it does, around line 47 — am
export async function revokeApiKey(pool: Pool, merchantId: string, apiKeyId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL`,
    [apiKeyId, merchantId],
  );
  return (result.rowCount ?? 0) > 0;
}
