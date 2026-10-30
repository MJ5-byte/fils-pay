import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import {
  getMerchantDetailForAdmin,
  listMerchantsForAdmin,
  merchantExists,
  UUID_RE,
} from "../admin/merchants.js";
import { rotateApiKeyAsAdmin } from "../admin/apiKeys.js";
import { startImpersonation } from "../admin/impersonation.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../lib/errors.js";
import { recordKycReviewInTx } from "../onboarding/review.js";
import { createWebhookDeliveryArchive, replayWebhookDeliveryArchive } from "../webhooks/archiveReplay.js";
import { DEFAULT_REPLAY_STATUSES, replayWebhookDeliveriesBatch } from "../webhooks/replayBatch.js";

interface MerchantIdParams {
  id: string;
}

interface ApiKeyRotateParams extends MerchantIdParams {
  keyId: string;
}

interface EndpointParams extends MerchantIdParams {
  endpointId: string;
}

interface ListQuery {
  q?: string;
  onboardingStatus?: string | string[];
  limit?: string;
  cursor?: string;
}

interface KycReviewBody {
  outcome?: "approved" | "rejected";
  notes?: string;
}

/** label for the NEW key; the old key's label is left as-is on the revoked row. */
interface RotateBody {
  label?: string;
}

interface ReplayBatchBody {
  from?: string;
  to?: string;
  statuses?: string[];
}

/**
 * from/to bound the deliveries archived (created_at, to exclusive). One call
 * archives at most 500 rows; `after` is the previous call's `nextCursor`.
 */
interface ArchiveCreateBody {
  from?: string;
  to?: string;
  after?: string;
}

interface ArchiveReplayParams extends EndpointParams {
  archiveId: string;
}

interface ArchiveReplayBody {
  targetEndpointId?: string;
  offset?: number;
}

/** A path id that isn't UUID-shaped can't name a row in any of these tables,
 *  so it is a 404 rather than a 500 from a failed cast deep inside a query. */
function assertUuidParam(value: string, code: string): void {
  if (!UUID_RE.test(value)) {
    throw new NotFoundError(code);
  }
}

/**
 * Registered with prefix '/v1/admin/merchants'. EVERY route here carries
 * `requireAdminSession`, and the money-adjacent ones additionally carry
 * `requireAdminRole(...)` — server-side, on the route, never only in
 * apps/admin's UI.
 */
export async function adminMerchantRoutes(app: FastifyInstance): Promise<void> {
  /** The one legitimately unscoped, cross-merchant query in the
   *  platform. Any admin role: reading the merchant list is what every
   *  support ticket starts with. */
  app.get<{ Querystring: ListQuery }>(
    "/",
    { preHandler: [requireAdminSession] },
    async (request) => {
      const q = request.query;
      const onboardingStatus =
        q.onboardingStatus === undefined
          ? undefined
          : Array.isArray(q.onboardingStatus)
            ? q.onboardingStatus
            : [q.onboardingStatus];
      const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

      return listMerchantsForAdmin(app.db, {
        q: q.q ?? null,
        onboardingStatus,
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: q.cursor ?? null,
      });
    },
  );

  /** Detail, composed from the existing per-table query functions. */
  app.get<{ Params: MerchantIdParams }>(
    "/:id",
    { preHandler: [requireAdminSession] },
    async (request) => {
      assertUuidParam(request.params.id, "merchant_not_found");
      const detail = await getMerchantDetailForAdmin(app.db, request.params.id);
      if (!detail) {
        throw new NotFoundError("merchant_not_found");
      }
      return detail;
    },
  );

  /**
   * KYC review. Replaced the old shared-secret
   * `POST /v1/internal/kyc-reviews` outright: there is no bearer-secret path
   * into this action any more.
   *
   * `finance`/`super_admin` only — approving a merchant is a money-adjacent
   * decision, so a `support` operator gets a 403 here.
   */
  app.post<{ Params: MerchantIdParams; Body: KycReviewBody }>(
    "/:id/kyc-reviews",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      const { outcome, notes } = request.body ?? {};
      if (outcome !== "approved" && outcome !== "rejected") {
        throw new BadRequestError("invalid_request", "outcome must be 'approved' or 'rejected'");
      }
      if (!(await merchantExists(app.db, request.params.id))) {
        throw new NotFoundError("merchant_not_found");
      }

      // The review's own writes and its audit row in ONE transaction, audit
      // last: if the audit insert throws, the merchants UPDATE that already
      // ran rolls back with it. The action and its record either both happen
      // or neither does.
      const result = await withTransaction(app.db, async (client) => {
        const reviewResult = await recordKycReviewInTx(client, {
          merchantId: request.params.id,
          outcome,
          reviewerIdentifier: adminAuth.email,
          reviewerAdminUserId: adminAuth.adminUserId,
          notes,
        });
        await insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "kyc_review",
          targetType: "merchant",
          targetId: request.params.id,
          metadata: { outcome, notes: notes ?? null },
        });
        return reviewResult;
      });

      reply.code(200).send(result);
    },
  );

  /** Atomic rotate: revoke + reissue + audit in one transaction. */
  app.post<{ Params: ApiKeyRotateParams; Body: RotateBody }>(
    "/:id/api-keys/:keyId/rotate",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      assertUuidParam(request.params.keyId, "api_key_not_found");

      const rotated = await rotateApiKeyAsAdmin(app.db, app.config, {
        merchantId: request.params.id,
        apiKeyId: request.params.keyId,
        adminUserId: adminAuth.adminUserId,
        label: request.body?.label,
      });

      // rawKey appears in this response body and nowhere else, ever — the
      // same show-once semantics as merchant-issued keys.
      reply.code(201).send({
        id: rotated.id,
        prefix: rotated.prefix,
        rawKey: rotated.rawKey,
        createdAt: rotated.createdAt.toISOString(),
        previousKeyId: rotated.previousKeyId,
      });
    },
  );

  /**
   * Webhook batch replay. `requireAdminSession` only (any role): it is
   * routine, reversible, and deduped receiver-side by construction, and no
   * money moves directly, so it is not gated to finance.
   */
  app.post<{ Params: EndpointParams; Body: ReplayBatchBody }>(
    // YA: deduped receiver-side by the stable Webhook-Delivery-Id. replay keeps the original id. correct
    "/:id/webhook-endpoints/:endpointId/replay-batch",
    { preHandler: [requireAdminSession] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      assertUuidParam(request.params.endpointId, "webhook_endpoint_not_found");

      const { from, to, statuses } = request.body ?? {};
      if (!from || !to) {
        throw new BadRequestError("invalid_request", "from and to are required ISO-8601 timestamps");
      }
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new BadRequestError("invalid_request", "from and to must be valid ISO-8601 timestamps");
      }
      if (fromDate.getTime() >= toDate.getTime()) {
        throw new BadRequestError("invalid_request", "from must be strictly before to");
      }
      if (statuses !== undefined && (!Array.isArray(statuses) || statuses.length === 0)) {
        throw new BadRequestError("invalid_request", "statuses, if given, must be a non-empty array");
      }

      const result = await replayWebhookDeliveriesBatch(app.db, {
        merchantId: request.params.id,
        endpointId: request.params.endpointId,
        adminUserId: adminAuth.adminUserId,
        from: fromDate,
        to: toDate,
        statuses: statuses ?? [...DEFAULT_REPLAY_STATUSES],
      });

      reply.code(200).send(result);
    },
  );

  /**
   * Capture a retained archive of one endpoint's delivery history
   * over a date range, ahead of a URL rotation or the endpoint being
   * disabled. Same preHandler policy as replay-batch above: reading and
   * snapshotting delivery history moves no money.
   */
  app.post<{ Params: EndpointParams; Body: ArchiveCreateBody }>(
    "/:id/webhook-endpoints/:endpointId/archive",
    { preHandler: [requireAdminSession] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      assertUuidParam(request.params.endpointId, "webhook_endpoint_not_found");

      const { from, to } = request.body ?? {};
      if (!from || !to) {
        throw new BadRequestError("invalid_request", "from and to are required ISO-8601 timestamps");
      }
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new BadRequestError("invalid_request", "from and to must be valid ISO-8601 timestamps");
      }
      if (fromDate.getTime() >= toDate.getTime()) {
        throw new BadRequestError("invalid_request", "from must be strictly before to");
      }

      const after = request.body?.after;
      if (after !== undefined && (typeof after !== "string" || !UUID_RE.test(after))) {
        throw new BadRequestError("invalid_request", "after must be a delivery id");
      }

      const result = await createWebhookDeliveryArchive(app.db, {
        merchantId: request.params.id,
        endpointId: request.params.endpointId,
        adminUserId: adminAuth.adminUserId,
        from: fromDate,
        to: toDate,
        ...(after !== undefined && { after }),
      });

      reply.code(201).send(result);
    },
  );

  /**
   * Restore a previously captured archive against an endpoint,
   * defaulting to the one it was captured from. The target may be a
   * different, newly registered endpoint: that is the "migrate history to a
   * rotated URL" case this archive exists for.
   */
  app.post<{ Params: ArchiveReplayParams; Body: ArchiveReplayBody }>(
    "/:id/webhook-endpoints/:endpointId/archive/:archiveId/replay",
    { preHandler: [requireAdminSession] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      assertUuidParam(request.params.archiveId, "webhook_delivery_archive_not_found");

      const targetEndpointId = request.body?.targetEndpointId ?? request.params.endpointId;
      assertUuidParam(targetEndpointId, "webhook_endpoint_not_found");

      const offset = request.body?.offset;
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        throw new BadRequestError("invalid_request", "offset must be a non-negative integer");
      }

      const result = await replayWebhookDeliveryArchive(app.db, {
        merchantId: request.params.id,
        archiveId: request.params.archiveId,
        targetEndpointId,
        adminUserId: adminAuth.adminUserId,
        ...(offset !== undefined && { offset }),
      });

      reply.code(200).send(result);
    },
  );

  /**
   * Start impersonation. Any admin role: a support operator needs
   * this for tickets, and the safety comes from the *scope* the grant
   * confers (merchant role 'support', always), not from restricting who may
   * start one.
   */
  app.post<{ Params: MerchantIdParams }>(
    "/:id/impersonate",
    { preHandler: [requireAdminSession] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      assertUuidParam(request.params.id, "merchant_not_found");
      if (!(await merchantExists(app.db, request.params.id))) {
        throw new NotFoundError("merchant_not_found");
      }

      const started = await startImpersonation(app.db, {
        adminUserId: adminAuth.adminUserId,
        merchantId: request.params.id,
        ttlMinutes: app.config.impersonationTtlMinutes,
      });

      // A third, distinct cookie. It is never read by requireAdminSession,
      // and fp_admin_sid is never read by requireMerchantAuth.
      reply.setCookie(app.config.impersonationCookieName, started.rawToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: app.config.impersonationTtlMinutes * 60,
      });

      reply.code(201).send({
        grantId: started.grantId,
        merchantId: started.merchantId,
        expiresAt: started.expiresAt.toISOString(),
      });
    },
  );
}
