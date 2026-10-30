import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { UnauthorizedError } from "../lib/errors.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** Approves the given merchants that are under review, records a review for each, and audits it. */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    const admin = await client.query<{ email: string }>(
      `SELECT email FROM admin_users WHERE id = $1`,
      [input.adminUserId],
    );
    const adminEmail = admin.rows[0]?.email;
    if (adminEmail === undefined) throw new UnauthorizedError("unauthenticated");

    // Lock in id order so two overlapping bulk approvals cannot deadlock, and so a
    // merchant rejected concurrently is either seen as rejected here or waits for us.
    const pending = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
        ORDER BY id
          FOR UPDATE`,
      [input.merchantIds],
    );
    const approvedMerchantIds = pending.rows.map((row) => row.id);

    // recordKycReviewInTx is the one writer of kyc_passed (0016), so each approval
    // leaves its merchant_kyc_reviews row. Two queries per merchant, at most 200 ids
    // per request (BULK_APPROVE_MAX_IDS).
    for (const merchantId of approvedMerchantIds) {
      await recordKycReviewInTx(client, {
        merchantId,
        outcome: "approved",
        reviewerIdentifier: adminEmail,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
