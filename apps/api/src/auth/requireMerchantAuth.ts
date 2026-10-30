import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { lookupImpersonationGrant } from "../admin/impersonation.js";
import { lookupSession } from "./sessions.js";

/** @property role null only for API keys. An impersonation actor always carries "support". */
export interface MerchantAuthContext {
  merchantId: string;
  actorType: "merchant_session" | "merchant_api_key" | "admin_impersonation";
  actorId: string; // sessions.id, api_keys.id, or admin_impersonation_grants.id
  /** The session actor's merchant_users.role, when actorType is
   *  'merchant_session'. Always null for actorType 'merchant_api_key' — an
   *  API key has no per-key role; see requireMerchantRole below
   *  for how that's handled, not ignored. For actorType 'admin_impersonation',
   *  the operator's merchant-plane role (see admin/impersonation.ts's role
   *  mapping). */
  role: "owner" | "finance" | "support" | null;
  /** Present only when actorType === 'admin_impersonation': which admin is
   *  looking. A merchant-facing audit trail should surface this when
   *  present, e.g. "viewed by support". */
  impersonatedByAdminUserId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    merchantAuth?: MerchantAuthContext;
  }
}

/**
 * Accepts EITHER a valid session cookie OR a valid API key. Tries the
 * session cookie first (cheaper, no crypto), falls back to the API-key
 * header. Populates `request.merchantAuth` or throws `UnauthorizedError`.
 *
 * This is the only source of truth for "which merchant is this request
 * allowed to act as" on the transactions surface — every handler that uses
 * it builds the `merchant_id` predicate on its queries from
 * `request.merchantAuth.merchantId`, never from a merchantId in the path or
 * body.
 *
 * Implementation reuses `lookupSession`/`verifyApiKey` verbatim —
 * it does not reimplement session or API-key validation, only sequences
 * the two existing checks and normalizes their result shape.
 */
export const requireMerchantAuth: preHandlerHookHandler = async (request: FastifyRequest): Promise<void> => {
  const token = request.cookies[request.server.config.cookieName];
  if (token) {
    const session = await lookupSession(request.server.db, token);
    if (session) {
      request.merchantAuth = {
        merchantId: session.merchantId,
        actorType: "merchant_session",
        actorId: session.sessionId,
        role: session.role,
      };
      return;
    }
  }

  const header = request.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const rawKey = header.slice("Bearer ".length);
    const apiKeyContext = await verifyApiKey(request.server.db, rawKey);
    if (apiKeyContext) {
      request.merchantAuth = {
        merchantId: apiKeyContext.merchantId,
        actorType: "merchant_api_key",
        actorId: apiKeyContext.apiKeyId,
        role: null,
      };
      return;
    }
  }

  // MK: order matters — a merchant holding an old fp_impersonation cookie gets mixed identities. FP-198
  // FH: tried old grant cookie + real merchant session, got the merchant identity as expected. can't see the bug
  // Third and last fallback: an operator's "view as merchant" grant, read from
  // its own cookie (never fp_admin_sid — this function does not know that
  // cookie's name and never looks at it). The grant resolves to the operator's
  // standing expressed in the merchant plane's own role vocabulary
  // (see admin/impersonation.ts), so the existing requireMerchantRole gates
  // apply to it exactly as they do to a real merchant session — one authority
  // model, no second "what may impersonation do" allowlist to drift from it.
  const impersonationToken = request.cookies[request.server.config.impersonationCookieName];
  if (impersonationToken) {
    const grant = await lookupImpersonationGrant(request.server.db, impersonationToken);
    if (grant) {
      request.merchantAuth = {
        merchantId: grant.merchantId,
        actorType: "admin_impersonation",
        actorId: grant.grantId,
        role: grant.merchantRole,
        impersonatedByAdminUserId: grant.adminUserId,
      };
      return;
    }
  }

  throw new UnauthorizedError("unauthenticated");
};

/**
 * The actor kinds the platform's write-attribution columns can represent:
 * `payment_links.created_by_type`, `webhook_endpoints.created_by_type` and
 * `transaction_events.actor_type` are all CHECK-constrained to exactly these
 * two.
 */
export type MerchantWriterActorType = "merchant_session" | "merchant_api_key";

export interface MerchantWriterActor {
  type: MerchantWriterActorType;
  id: string;
}

/**
 * Resolves an authenticated merchant actor to the `(type, id)` pair the
 * write-attribution columns store. `payment_links.created_by_type`,
 * `webhook_endpoints.created_by_type` and `transaction_events.actor_type` are
 * CHECK-constrained to the two persisted actor kinds; the companion `*_id`
 * column is the resolved actor's id.
 *
 * An API-key write attributes to the key. A cookie-authenticated write
 * attributes to the session actor the cookie resolved, carrying that actor's
 * id — cookie-borne merchant requests share one persisted actor kind.
 */
// impersonation writes get recorded as merchant_session here — audit cant tell admin from merchant? — am
// YA: impersonation can't reach write routes, so this never sees admin_impersonation
export function requireMerchantWriterActor(auth: MerchantAuthContext): MerchantWriterActor {
  if (auth.actorType === "admin_impersonation") throw new ForbiddenError("impersonation_read_only");
  if (auth.actorType === "merchant_api_key") {
    return { type: "merchant_api_key", id: auth.actorId };
  }
  return { type: "merchant_session", id: auth.actorId };
}

/**
 * Must be chained after requireMerchantAuth. An API-key actor is always
 * allowed through regardless of the roles list — API keys are issued
 * exclusively by an `owner` (requireRole('owner') on POST .../api-keys) and
 * are treated, once issued, as carrying the full merchant-level authority a
 * server-to-server integration needs — the same as authorize (a
 * money-moving, API-key-only endpoint), which checks nothing finer than "is
 * this a valid key for this merchant."
 * A session actor is checked against `roles` exactly like requireRole does
 * for the session-only surface.
 */
// FH: API keys skip the role check entirely — claude calls it privilege escalation
// MK: by design. keys are owner-issued.
export function requireMerchantRole(
  ...roles: Array<"owner" | "finance" | "support">
): preHandlerHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = request.merchantAuth;
    if (!auth) throw new UnauthorizedError("unauthenticated");
    if (auth.actorType === "admin_impersonation") throw new ForbiddenError("forbidden");
    if (auth.actorType === "merchant_api_key") return; // full merchant authority, by construction
    if (!auth.role || !roles.includes(auth.role)) throw new ForbiddenError("forbidden");
  };
}
