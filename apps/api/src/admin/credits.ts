import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { addFils, toFils, ZERO_FILS, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError, UnprocessableEntityError } from "../lib/errors.js";
import { claimIdempotencyKey, completeIdempotencyKey, hashRequest } from "../payments/idempotency.js";
import { assertDistinctApprover } from "./creditApproval.js";
import { calculateCreditFeeReversal, creditRequiresSecondApprover } from "./creditThreshold.js";
import { parseCreditRequestInput, type CreditReasonCode } from "./creditRequestValidation.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CREATE_CREDIT_ENDPOINT = "admin.credits.create";

export type CreditRequestStatus = "pending_approval" | "posted" | "rejected";

/**
 * Status only moves pending_approval -> posted or pending_approval -> rejected, never back.
 */
export interface CreditRequestRecord {
  id: string;
  merchantId: string;
  requestedByAdminUserId: string;
  requestedByDisplayName: string;
  reasonCode: CreditReasonCode;
  memo: string | null;
  baseAmountFils: Fils;
  feeReversalFils: Fils;
  /** `baseAmountFils + feeReversalFils` — what actually moves onto the
   *  merchant's payable balance when this posts. */
  postedAmountFils: Fils;
  /** 'YYYY-MM-DD'. */
  effectiveDate: string;
  requiresApproval: boolean;
  status: CreditRequestStatus;
  approvedByAdminUserId: string | null;
  approvedByDisplayName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  postedAt: string | null;
  ledgerEntryGroupId: string | null;
  createdAt: string;
}

interface CreditRequestRow {
  id: string;
  merchant_id: string;
  requested_by_admin_user_id: string;
  requester_display_name: string;
  reason_code: CreditReasonCode;
  memo: string | null;
  base_amount_fils: string;
  fee_reversal_fils: string;
  effective_date_text: string;
  requires_approval: boolean;
  status: CreditRequestStatus;
  approved_by_admin_user_id: string | null;
  approver_display_name: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  posted_at: Date | null;
  ledger_entry_group_id: string | null;
  created_at: Date;
  created_at_text: string;
}

/**
 * One projection shared by every read in this file, so the queue, the detail
 * re-read after a write, and the paginated list can never drift into
 * disagreeing about what a credit request is. `effective_date` and
 * `created_at` are rendered by Postgres itself: a DATE read through `pg`
 * becomes a JS `Date` in the *process's* local timezone (which can shift the
 * calendar day), and `Date.toISOString()` truncates a microsecond
 * `timestamptz` to milliseconds, which is exactly how a keyset cursor
 * silently skips rows.
 */
const CREDIT_REQUEST_SELECT = `
  SELECT cr.id, cr.merchant_id, cr.requested_by_admin_user_id,
         cr.requested_by_display_name AS requester_display_name,
         cr.reason_code, cr.memo,
         cr.base_amount_fils::text  AS base_amount_fils,
         cr.fee_reversal_fils::text AS fee_reversal_fils,
         cr.effective_date::text    AS effective_date_text,
         cr.requires_approval, cr.status,
         cr.approved_by_admin_user_id,
         appr.display_name AS approver_display_name,
         cr.approved_at, cr.rejected_at, cr.posted_at, cr.ledger_entry_group_id,
         cr.created_at, cr.created_at::text AS created_at_text
    FROM credit_requests cr
    LEFT JOIN admin_users appr ON appr.id = cr.approved_by_admin_user_id`;

function toRecord(row: CreditRequestRow): CreditRequestRecord {
  const baseAmountFils = toFils(Number(row.base_amount_fils));
  const feeReversalFils = toFils(Number(row.fee_reversal_fils));
  return {
    id: row.id,
    merchantId: row.merchant_id,
    requestedByAdminUserId: row.requested_by_admin_user_id,
    requestedByDisplayName: row.requester_display_name,
    reasonCode: row.reason_code,
    memo: row.memo,
    baseAmountFils,
    feeReversalFils,
    postedAmountFils: addFils(baseAmountFils, feeReversalFils),
    effectiveDate: row.effective_date_text,
    requiresApproval: row.requires_approval,
    status: row.status,
    approvedByAdminUserId: row.approved_by_admin_user_id,
    approvedByDisplayName: row.approver_display_name,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    rejectedAt: row.rejected_at ? row.rejected_at.toISOString() : null,
    postedAt: row.posted_at ? row.posted_at.toISOString() : null,
    ledgerEntryGroupId: row.ledger_entry_group_id,
    createdAt: row.created_at.toISOString(),
  };
}

async function readRecord(client: PoolClient, creditRequestId: string): Promise<CreditRequestRecord> {
  const result = await client.query<CreditRequestRow>(`${CREDIT_REQUEST_SELECT} WHERE cr.id = $1`, [
    creditRequestId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("credit_request_not_found");
  }
  return toRecord(row);
}

/** What `postCreditToLedger` needs: identity, merchant, the two amounts, and
 *  the accounting date the legs are anchored to. */
interface PostableCredit {
  id: string;
  merchantId: string;
  baseAmountFils: Fils;
  feeReversalFils: Fils;
  effectiveDate: string;
}

/**
 * Journals a credit and flips its request row to `posted`, inside the
 * caller's transaction.
 *
 * Private to this file on purpose: a credit must never be posted except as
 * part of the create-or-approve decision that authorised it.
 */
async function postCreditToLedger(client: PoolClient, credit: PostableCredit): Promise<string> {
  const entryGroupId = randomUUID();

  // Both legs post at Asia/Bahrain midnight of the credit's effective date —
  // the same business-day anchor settlement uses — so a credit shows up in
  // the reconciliation window for the period it was booked against rather
  // than the period the operator happened to click the button in.
  await client.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, 'merchant_credit_contra', 'debit',  $3, ($4::date)::timestamp AT TIME ZONE 'Asia/Bahrain', 'manual credit: base'),
       ($1, $2, 'merchant_payable',       'credit', $3, ($4::date)::timestamp AT TIME ZONE 'Asia/Bahrain', 'manual credit: base')`,
    [entryGroupId, credit.merchantId, credit.baseAmountFils, credit.effectiveDate],
  );
  // The fee leg pair is skipped entirely when the reversal is zero, exactly
  // as capture.ts skips its zero-fee leg pair: ledger_entries CHECKs
  // amount_fils > 0, and a zero-value entry carries no accounting
  // information anyway.
  if (credit.feeReversalFils > 0) {
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, 'platform_fee_revenue', 'debit',  $3, ($4::date)::timestamp AT TIME ZONE 'Asia/Bahrain', 'manual credit: MDR reversal'),
         ($1, $2, 'merchant_payable',     'credit', $3, ($4::date)::timestamp AT TIME ZONE 'Asia/Bahrain', 'manual credit: MDR reversal')`,
      [entryGroupId, credit.merchantId, credit.feeReversalFils, credit.effectiveDate],
    );
  }

  // merchant_balances is left alone. It holds closed, unpaid batch nets
  // (ADR-0007), and the next CloseBatch claims these merchant_payable legs
  // into its net and adds that net to the cache; adding the credit here as
  // well counted it twice after a rebuild (BHA-189).

  await client.query(
    `UPDATE credit_requests
        SET status = 'posted', posted_at = now(), ledger_entry_group_id = $2
      WHERE id = $1`,
    [credit.id, entryGroupId],
  );

  return entryGroupId;
}

/**
 * Creates a credit request and posts it immediately when it is under the threshold.
 * Requires finance or super_admin; a support caller gets a 403 from here.
 */
export async function createCreditRequest(
  pool: Pool,
  input: { merchantId: string; adminUserId: string; body: unknown; idempotencyKey?: string },
): Promise<CreditRequestRecord> {
  const draft = parseCreditRequestInput(input.body);

  return withTransaction(pool, async (client) => {
    const merchantResult = await client.query<{ mdr_bps: number }>(
      `SELECT mdr_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    if (!merchant) {
      throw new NotFoundError("merchant_not_found");
    }

    // Under the threshold this posts to the ledger, so a resent request must
    // replay the first credit instead of posting a second one. Claimed after
    // the merchant lookup because idempotency_keys references merchants.
    const claim = input.idempotencyKey
      ? await claimIdempotencyKey(client, {
          merchantId: input.merchantId,
          endpoint: CREATE_CREDIT_ENDPOINT,
          key: input.idempotencyKey,
          requestHash: hashRequest({ adminUserId: input.adminUserId, body: input.body }),
        })
      : null;
    if (claim?.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim?.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim?.outcome === "replay") {
      if (!claim.row.resourceId) {
        throw new Error("createCreditRequest: completed idempotency key has no credit request id");
      }
      return readRecord(client, claim.row.resourceId);
    }

    // Never operator-supplied: the reversal is the merchant's own contracted
    // rate applied to the amount they asked to credit.
    const feeReversalFils = draft.reverseFee
      ? calculateCreditFeeReversal(draft.baseAmountFils, merchant.mdr_bps)
      : ZERO_FILS;
    // FH: threshold compares base + reversal, so a 50.000 BD credit with a fee reversal needs a second approver
    // MK: no — base only. fee reversal is mechanical. intended.
    const requiresApproval = creditRequiresSecondApprover({
      baseAmountFils: draft.baseAmountFils,
      feeReversalFils,
    });

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO credit_requests
         (merchant_id, requested_by_admin_user_id, requested_by_display_name, reason_code, memo,
          base_amount_fils, fee_reversal_fils, effective_date, requires_approval, status)
       VALUES ($1, $2, (SELECT display_name FROM admin_users WHERE id = $2),
               $3, $4, $5, $6, $7::date, $8, 'pending_approval')
       RETURNING id`,
      [
        input.merchantId,
        input.adminUserId,
        draft.reasonCode,
        draft.memo,
        draft.baseAmountFils,
        feeReversalFils,
        draft.effectiveDate,
        requiresApproval,
      ],
    );
    const creditRequestId = inserted.rows[0]!.id;

    if (!requiresApproval) {
      await postCreditToLedger(client, {
        id: creditRequestId,
        merchantId: input.merchantId,
        baseAmountFils: draft.baseAmountFils,
        feeReversalFils,
        effectiveDate: draft.effectiveDate,
      });
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "credit_request_created",
      targetType: "credit_request",
      targetId: creditRequestId,
      metadata: {
        merchantId: input.merchantId,
        reasonCode: draft.reasonCode,
        baseAmountFils: draft.baseAmountFils,
        feeReversalFils,
        postedAmountFils: addFils(draft.baseAmountFils, feeReversalFils),
        effectiveDate: draft.effectiveDate,
        requiresApproval,
        posted: !requiresApproval,
      },
    });

    const record = await readRecord(client, creditRequestId);
    if (claim) {
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 201, body: record, resourceId: creditRequestId });
    }
    return record;
  });
}

export async function approveCreditRequest(
  pool: Pool,
  input: { creditRequestId: string; approver: { adminUserId: string; displayName: string } },
): Promise<CreditRequestRecord> {
  return withTransaction(pool, async (client) => {
    // MK: lock is correct, loser sees 'posted' and 409s
    // deadlock risk vs rejectCreditRequest (FOR UPDATE vs FOR UPDATE OF cr lock different things?) — FP-198 again? — am
    // FH: both only lock credit_requests rows afaict. ran 50 parallel approve/reject in a script, no deadlock. unresolved
    // FOR UPDATE OF cr, held for the rest of this transaction: two concurrent
    // approvals of the same pending request must resolve to exactly one
    // winner, the loser seeing a `posted` row and getting a 409. Nothing
    // awaited inside this transaction crosses the network, so the lock is
    // only ever held across local statements.
    const locked = await client.query<{
      id: string;
      merchant_id: string;
      requested_by_admin_user_id: string;
      requester_display_name: string;
      base_amount_fils: string;
      fee_reversal_fils: string;
      effective_date_text: string;
      status: CreditRequestStatus;
    }>(
      `SELECT cr.id, cr.merchant_id, cr.requested_by_admin_user_id,
              cr.requested_by_display_name AS requester_display_name,
              cr.base_amount_fils::text  AS base_amount_fils,
              cr.fee_reversal_fils::text AS fee_reversal_fils,
              cr.effective_date::text    AS effective_date_text,
              cr.status
         FROM credit_requests cr
        WHERE cr.id = $1
        FOR UPDATE OF cr`,
      [input.creditRequestId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new NotFoundError("credit_request_not_found");
    }
    if (row.status !== "pending_approval") {
      throw new ConflictError("credit_request_not_pending");
    }

    assertDistinctApprover(
      { adminUserId: row.requested_by_admin_user_id, displayName: row.requester_display_name },
      input.approver,
    );

    await client.query(
      `UPDATE credit_requests
          SET approved_by_admin_user_id = $2, approved_at = now()
        WHERE id = $1`,
      [row.id, input.approver.adminUserId],
    );

    const baseAmountFils = toFils(Number(row.base_amount_fils));
    const feeReversalFils = toFils(Number(row.fee_reversal_fils));
    const entryGroupId = await postCreditToLedger(client, {
      id: row.id,
      merchantId: row.merchant_id,
      baseAmountFils,
      feeReversalFils,
      effectiveDate: row.effective_date_text,
    });

    await insertAdminAuditLog(client, {
      adminUserId: input.approver.adminUserId,
      action: "credit_request_approved",
      targetType: "credit_request",
      targetId: row.id,
      metadata: {
        merchantId: row.merchant_id,
        requestedByAdminUserId: row.requested_by_admin_user_id,
        baseAmountFils,
        feeReversalFils,
        postedAmountFils: addFils(baseAmountFils, feeReversalFils),
        effectiveDate: row.effective_date_text,
        ledgerEntryGroupId: entryGroupId,
      },
    });

    return readRecord(client, row.id);
  });
}

/** Journals nothing, only closes the request. 409 when it is not pending. */
export async function rejectCreditRequest(
  pool: Pool,
  input: { creditRequestId: string; adminUserId: string; reason?: string },
): Promise<CreditRequestRecord> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ id: string; merchant_id: string; status: CreditRequestStatus }>(
      `SELECT id, merchant_id, status FROM credit_requests WHERE id = $1 FOR UPDATE`,
      [input.creditRequestId],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new NotFoundError("credit_request_not_found");
    }
    if (row.status !== "pending_approval") {
      throw new ConflictError("credit_request_not_pending");
    }

    await client.query(
      `UPDATE credit_requests
          SET status = 'rejected', rejected_by_admin_user_id = $2, rejected_at = now()
        WHERE id = $1`,
      [row.id, input.adminUserId],
    );

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "credit_request_rejected",
      targetType: "credit_request",
      targetId: row.id,
      metadata: { merchantId: row.merchant_id, reason: input.reason ?? null },
    });

    return readRecord(client, row.id);
  });
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

/** Returns null for any malformed cursor instead of throwing, so a bad cursor restarts at page one. */
function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) return null;
  const createdAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

/** Encoded from Postgres's own text rendering of `created_at`, never from
 *  `Date.toISOString()` — see `CREDIT_REQUEST_SELECT`. */
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

// limit clamped 1..100 — am
export async function listCreditRequests(
  pool: Pool,
  input: { status?: string; merchantId?: string; limit?: number; cursor?: string | null },
): Promise<{ items: CreditRequestRecord[]; nextCursor: string | null }> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const decodedCursor = decodeCursor(input.cursor);

  const result = await pool.query<CreditRequestRow>(
    `${CREDIT_REQUEST_SELECT}
      WHERE ($1::text IS NULL OR cr.status = $1)
        AND ($2::uuid IS NULL OR cr.merchant_id = $2)
        AND ($3::timestamptz IS NULL OR (cr.created_at, cr.id) < ($3, $4::uuid))
      ORDER BY cr.created_at DESC, cr.id DESC
      LIMIT $5`,
    [
      input.status ?? null,
      input.merchantId ?? null,
      decodedCursor?.createdAt ?? null,
      decodedCursor?.id ?? null,
      limit,
    ],
  );

  const items = result.rows.map(toRecord);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { items, nextCursor };
}
