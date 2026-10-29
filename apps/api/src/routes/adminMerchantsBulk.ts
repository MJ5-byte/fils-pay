import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { UUID_RE } from "../admin/merchants.js";
import { bulkApproveMerchantsKyc } from "../admin/bulkKyc.js";
import { BadRequestError, UnauthorizedError } from "../lib/errors.js";

/** Same idea as the webhook batch-replay cap — a bound on how much
 *  work one request can trigger, not a correctness check on the ids
 *  themselves. */
const BULK_APPROVE_MAX_IDS = 200;

/** merchantIds: UUIDs, at most BULK_APPROVE_MAX_IDS. notes: copied into the audit row metadata. */
interface BulkApproveBody {
  merchantIds?: string[];
  notes?: string;
}

/** Bulk KYC approval endpoint. */
export async function adminMerchantsBulkRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: BulkApproveBody }>(
    "/bulk-approve",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      const { merchantIds, notes } = request.body ?? {};
      if (!Array.isArray(merchantIds) || merchantIds.length === 0) {
        throw new BadRequestError("invalid_request", "merchantIds must be a non-empty array");
      }
      // 200 max, so the per-merchant review writes stay under the statement timeout — am
      if (merchantIds.length > BULK_APPROVE_MAX_IDS) {
        throw new BadRequestError(
          "invalid_request",
          `merchantIds must not exceed ${BULK_APPROVE_MAX_IDS} per request`,
        );
      }
      if (!merchantIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
        throw new BadRequestError("invalid_request", "merchantIds must all be UUIDs");
      }

      // Ids that name no merchant, or a merchant not under_review, are simply
      // skipped, so existence needs no separate probe here — the response's
      // approvedMerchantIds is the authoritative list of what actually moved.
      const result = await bulkApproveMerchantsKyc(app.db, {
        merchantIds,
        adminUserId: adminAuth.adminUserId,
        notes,
      });

      reply.code(200).send(result);
    },
  );
}
