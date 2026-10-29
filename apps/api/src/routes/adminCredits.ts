import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import {
  approveCreditRequest,
  createCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "../admin/credits.js";
import { UUID_RE } from "../admin/merchants.js";
import { NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface MerchantIdParams {
  id: string;
}

interface CreditRequestIdParams {
  creditRequestId: string;
}

interface ListQuery {
  status?: string;
  merchantId?: string;
  limit?: string;
  cursor?: string;
}

/** reason is required and stored on the credit request; it is shown to the requester, not the merchant. */
interface RejectBody {
  reason?: string;
}

/** A path id that isn't UUID-shaped can't name a row in any of these tables,
 *  so it is a 404 rather than a 500 from a failed cast deep inside a query. */
function assertUuidParam(value: string, code: string): void {
  if (!UUID_RE.test(value)) {
    throw new NotFoundError(code);
  }
}

export async function adminCreditRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (scope) => {
    scope.addHook("preHandler", requireAdminSession);

    scope.get<{ Querystring: ListQuery }>(
      "/credits",
      async (request) => {
        const q = request.query;
        if (q.merchantId !== undefined) {
          assertUuidParam(q.merchantId, "merchant_not_found");
        }
        const limit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;

        return listCreditRequests(app.db, {
          status: q.status,
          merchantId: q.merchantId,
          limit: Number.isFinite(limit) ? limit : undefined,
          cursor: q.cursor ?? null,
        });
      },
    );

    scope.post<{ Params: MerchantIdParams; Body: unknown }>(
      "/merchants/:id/credits",
      { preHandler: requireAdminRole("finance", "super_admin") },
      async (request, reply) => {
        const adminAuth = request.adminAuth;
        if (!adminAuth) throw new UnauthorizedError("unauthenticated");

        assertUuidParam(request.params.id, "merchant_not_found");

        const record = await createCreditRequest(app.db, {
          merchantId: request.params.id,
          adminUserId: adminAuth.adminUserId,
          body: request.body,
        });
        reply.code(201).send(record);
      },
    );
  });

  app.register(async (scope) => {
    scope.addHook("preHandler", requireAdminSession);
    scope.addHook("preHandler", requireAdminRole("finance", "super_admin"));

    scope.post<{ Params: CreditRequestIdParams }>(
      "/credits/:creditRequestId/approve",
      async (request, reply) => {
        const adminAuth = request.adminAuth;
        if (!adminAuth) throw new UnauthorizedError("unauthenticated");

        assertUuidParam(request.params.creditRequestId, "credit_request_not_found");

        const approverResult = await app.db.query<{ display_name: string }>(
          `SELECT display_name FROM admin_users WHERE id = $1`,
          [adminAuth.adminUserId],
        );
        const approverRow = approverResult.rows[0];
        if (!approverRow) throw new UnauthorizedError("unauthenticated");

        const record = await approveCreditRequest(app.db, {
          creditRequestId: request.params.creditRequestId,
          approver: { adminUserId: adminAuth.adminUserId, displayName: approverRow.display_name },
        });
        reply.code(200).send(record);
      },
    );

    scope.post<{ Params: CreditRequestIdParams; Body: RejectBody }>(
      "/credits/:creditRequestId/reject",
      async (request, reply) => {
        const adminAuth = request.adminAuth;
        if (!adminAuth) throw new UnauthorizedError("unauthenticated");

        assertUuidParam(request.params.creditRequestId, "credit_request_not_found");

        const record = await rejectCreditRequest(app.db, {
          creditRequestId: request.params.creditRequestId,
          adminUserId: adminAuth.adminUserId,
          reason: request.body?.reason,
        });
        reply.code(200).send(record);
      },
    );
  });
}
