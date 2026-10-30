import type { Pool } from "pg";
import { toFils, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError, UnprocessableEntityError } from "../lib/errors.js";
import { claimIdempotencyKey, completeIdempotencyKey, hashRequest } from "../payments/idempotency.js";
import { postLedgerAdjustment } from "./ledgerAdjustments.js";

export interface BalanceAdjustmentInput {
  merchantId: string;
  adminUserId: string;
  /** A correction can go either way, so this is a signed delta. */
  deltaFils: Fils;
  reason: string;
  /** The route always sends one; a resend with the same key replays the first result. */
  idempotencyKey?: string;
}

const BALANCE_CORRECTION_ENDPOINT = "admin.balance_adjustments.create";

/** Before/after are the unchanged cache value read while holding the merchant row lock. */
export interface BalanceAdjustmentResult {
  merchantId: string;
  deltaFils: Fils;
  cachedPayableFilsBefore: Fils;
  cachedPayableFilsAfter: Fils;
}

/** Posts the correction to the ledger; the cache picks it up at the next settlement close. */
export async function applyBalanceCorrection(
  pool: Pool,
  input: BalanceAdjustmentInput,
): Promise<BalanceAdjustmentResult> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ cached_payable_fils: string | null }>(
      `SELECT b.cached_payable_fils FROM merchants m LEFT JOIN merchant_balances b ON b.merchant_id = m.id WHERE m.id = $1 FOR UPDATE OF m`,
      [input.merchantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError("merchant_not_found");
    }
    const before = toFils(Number(row.cached_payable_fils ?? 0), { allowNegative: true });

    // A delta is not idempotent by itself: a resent correction would move the
    // balance twice. Claimed after the merchants row lock, which proves the merchant
    // exists for idempotency_keys' foreign key.
    const claim = input.idempotencyKey
      ? await claimIdempotencyKey(client, {
          merchantId: input.merchantId,
          endpoint: BALANCE_CORRECTION_ENDPOINT,
          key: input.idempotencyKey,
          requestHash: hashRequest({ adminUserId: input.adminUserId, deltaFils: input.deltaFils, reason: input.reason }),
        })
      : null;
    if (claim?.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim?.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim?.outcome === "replay") {
      if (!isBalanceAdjustmentResult(claim.row.responseBody)) {
        throw new Error("applyBalanceCorrection: completed idempotency key has no stored result");
      }
      return claim.row.responseBody;
    }

    const entryGroupId = await postLedgerAdjustment(client, input.merchantId, input.deltaFils);
    const after = before;

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "balance_adjustment",
      targetType: "merchant",
      targetId: input.merchantId,
      metadata: { deltaFils: input.deltaFils, reason: input.reason, before, after, entryGroupId },
    });

    const result: BalanceAdjustmentResult = {
      merchantId: input.merchantId,
      deltaFils: input.deltaFils,
      cachedPayableFilsBefore: before,
      cachedPayableFilsAfter: after,
    };
    if (claim) {
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 200, body: result });
    }
    return result;
  });
}

function isBalanceAdjustmentResult(value: unknown): value is BalanceAdjustmentResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.merchantId === "string" &&
    Number.isSafeInteger(v.deltaFils) &&
    Number.isSafeInteger(v.cachedPayableFilsBefore) &&
    Number.isSafeInteger(v.cachedPayableFilsAfter)
  );
}

/** Journaled variant: posts ledger legs alongside the cache correction. */
export async function adjustMerchantBalanceJournaled(
  pool: Pool,
  input: BalanceAdjustmentInput,
): Promise<BalanceAdjustmentResult> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ cached_payable_fils: string }>(
      `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1 FOR UPDATE`,
      [input.merchantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError("merchant_balance_not_found");
    }
    const before = toFils(Number(row.cached_payable_fils), { allowNegative: true });

    const entryGroupId = await postLedgerAdjustment(client, input.merchantId, input.deltaFils);

    const updated = await client.query<{ cached_payable_fils: string }>(
      `UPDATE merchant_balances
          SET cached_payable_fils = cached_payable_fils + $2, updated_at = now()
        WHERE merchant_id = $1
      RETURNING cached_payable_fils`,
      [input.merchantId, input.deltaFils],
    );
    const after = toFils(Number(updated.rows[0]!.cached_payable_fils), { allowNegative: true });

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "balance_adjustment_journaled",
      targetType: "merchant",
      targetId: input.merchantId,
      metadata: {
        deltaFils: input.deltaFils,
        reason: input.reason,
        entryGroupId,
        before,
        after,
      },
    });

    return {
      merchantId: input.merchantId,
      deltaFils: input.deltaFils,
      cachedPayableFilsBefore: before,
      cachedPayableFilsAfter: after,
    };
  });
}
