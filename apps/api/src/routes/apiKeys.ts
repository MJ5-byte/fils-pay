import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole, requireSession } from "../auth/middleware.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../apiKeys/issue.js";
import { UUID_RE } from "../admin/merchants.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

interface MerchantIdParams {
  merchantId: string;
}

interface ApiKeyIdParams extends MerchantIdParams {
  id: string;
}

interface IssueApiKeyBody {
  label?: string;
}

// YA: 403 for another merchant's path. arch says 404 everywhere? Claude says 403 is "more RESTful"
// FH: path merchant is not a secret (the caller typed it). 403 is fine here
function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.auth || request.auth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

/**
 * Registered with prefix '/v1/merchants'. API keys are the most sensitive
 * credential a merchant holds, so issuance/listing/revocation are
 * restricted to the `owner` role — more tightly than KYC/profile actions.
 */
export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: IssueApiKeyBody }>(
    "/:merchantId/api-keys",
    // am: requireSession = pending sessions too? i.e. password but no otp yet
    // MK: no, pending sessions can't reach this, requireSession checks authenticated. see auth/sessions.ts
    { preHandler: [requireSession, requireRole("owner")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const issued = await issueApiKey(app.db, app.config, {
        merchantId: request.params.merchantId,
        createdBy: request.auth!.merchantUserId,
        label: request.body?.label,
      });
      // rawKey appears in this response body and nowhere else, ever.
      reply.code(201).send({
        id: issued.id,
        prefix: issued.prefix,
        rawKey: issued.rawKey,
        createdAt: issued.createdAt.toISOString(),
      });
    },
  );

  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/api-keys",
    { preHandler: [requireSession, requireRole("owner")] },
    async (request) => {
      assertOwnMerchant(request);
      return listApiKeys(app.db, request.params.merchantId);
    },
  );

  app.delete<{ Params: ApiKeyIdParams }>(
    "/:merchantId/api-keys/:id",
    { preHandler: [requireSession, requireRole("owner")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("api_key_not_found");
      }
      const revoked = await revokeApiKey(app.db, request.params.merchantId, request.params.id);
      if (!revoked) {
        throw new NotFoundError("api_key_not_found");
      }
      reply.code(204).send();
    },
  );
}
