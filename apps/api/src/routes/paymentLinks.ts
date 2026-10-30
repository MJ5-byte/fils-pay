import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { getPublicPaymentLink } from "../paymentLinks/read.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { getMerchantPaymentLink, listPaymentLinks } from "../paymentLinks/query.js";
import { assertValidCard } from "../payments/authorize.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface MerchantIdParams {
  merchantId: string;
}

interface MerchantLinkIdParams extends MerchantIdParams {
  id: string;
}

interface TokenParams {
  token: string;
}

interface CreatePaymentLinkBody {
  amountFils?: number;
  reference?: string;
  description?: string;
  expiresAt?: string;
}

/**
 * card: simulated card input. submittedAt: optional ISO-8601 instant from an
 * offline terminal; ignored unless the request is authenticated with an API
 * key.
 */
interface PayPaymentLinkBody {
  card?: SimulatedCardInput;
  submittedAt?: string;
}

interface ListPaymentLinksQuery {
  status?: string | string[];
  limit?: string;
  cursor?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres's own text rendering of a timestamptz, as written by the query module's encodeCursor.
const PG_TIMESTAMPTZ_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::?(\d{2}))?$/;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new BadRequestError("invalid_limit", "limit must be a positive integer");
  }
  return Number(raw);
}

function isRealTimestamp(text: string): boolean {
  const m = PG_TIMESTAMPTZ_RE.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s, tzh, tzm] = m.slice(1).map((part) => Number(part ?? 0));
  return (
    mo! >= 1 && mo! <= 12 && d! >= 1 && d! === new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDate() &&
    h! < 24 && mi! < 60 && s! < 60 && tzh! <= 15 && tzm! < 60
  );
}

/**
 * The query modules turn a malformed cursor into page one; reject it here instead.
 * Same helpers live in routes/paymentLinks.ts and routes/transactions.ts: change both.
 */
function assertValidCursor(cursor: string | undefined): void {
  if (!cursor) return;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separatorIndex = decoded.indexOf("|");
  const timestamp = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (separatorIndex === -1 || !isRealTimestamp(timestamp) || !UUID_RE.test(id)) {
    throw new BadRequestError("invalid_cursor", "cursor is not valid");
  }
}

// am: this is the ownership check for create/cancel/list. cancel.ts relies on it, link ids are UUIDs
// MK: it checks the path merchant, not that the link belongs to that merchant?
function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.merchantAuth || request.merchantAuth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

/** Same rule as routes/transactions.ts: header required, no server-generated fallback. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Merchant-authenticated payment-link routes: create, cancel, list.
 * Registered with prefix '/v1/merchants' — a *separate* registration from
 * `paymentLinkPublicRoutes` below, so there is no ambiguity in app.ts
 * between what requires `requireMerchantAuth` and what is deliberately
 * public.
 */
export async function paymentLinkMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: CreatePaymentLinkBody }>(
    "/:merchantId/payment-links",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const { amountFils, reference, description, expiresAt } = request.body ?? {};
      if (amountFils === undefined || !expiresAt) {
        throw new BadRequestError("invalid_request", "amountFils and expiresAt are required");
      }
      if (typeof amountFils === "number" && amountFils <= 0) {
        throw new BadRequestError("invalid_amount", "amountFils must be greater than zero");
      }

      const writer = requireMerchantWriterActor(request.merchantAuth!);
      const link = await createPaymentLink(app.db, app.config, {
        merchantId: request.params.merchantId,
        amountFils,
        reference,
        description,
        expiresAt,
        createdByType: writer.type,
        createdById: writer.id,
      });
      reply.code(201).send(link);
    },
  );

  app.delete<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      if (!UUID_RE.test(request.params.id)) {
        throw new BadRequestError("invalid_id", "id must be a UUID");
      }
      const result = await cancelPaymentLink(app.db, {
        id: request.params.id,
        merchantId: request.params.merchantId,
      });
      if (result.outcome === "canceled") {
        reply.code(204).send();
        return;
      }
      if (result.outcome === "not_found") {
        throw new NotFoundError("payment_link_not_found");
      }
      throw new ConflictError("not_cancelable", `status: ${result.status}`);
    },
  );

  app.get<{ Params: MerchantLinkIdParams }>(
    "/:merchantId/payment-links/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      if (!UUID_RE.test(request.params.id)) {
        throw new BadRequestError("invalid_id", "id must be a UUID");
      }
      const link = await getMerchantPaymentLink(app.db, app.config, request.params.merchantId, request.params.id);
      if (!link) {
        throw new NotFoundError("payment_link_not_found");
      }
      return link;
    },
  );

  app.get<{ Params: MerchantIdParams; Querystring: ListPaymentLinksQuery }>(
    "/:merchantId/payment-links",
    { preHandler: requireMerchantAuth },
    async (request) => {
      assertOwnMerchant(request);
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseLimit(q.limit);
      assertValidCursor(q.cursor);

      return listPaymentLinks(app.db, app.config, {
        merchantId: request.params.merchantId,
        status,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );
}

/**
 * Public, unauthenticated payment-link routes: read, pay. Registered with
 * prefix '/v1/payment-links'.
 */
export async function paymentLinkPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: TokenParams }>("/:token", async (request) => {
    const link = await getPublicPaymentLink(
      app.db,
      request.params.token,
      app.config.paymentLinkReservationTimeoutSeconds,
    );
    if (!link) {
      throw new NotFoundError("payment_link_not_found");
    }
    return link;
  });

  app.post<{ Params: TokenParams; Body: PayPaymentLinkBody }>("/:token/pay", async (request, reply) => {
    const idempotencyKey = getIdempotencyKey(request);
    const { card } = request.body ?? {};
    // Validate before payPaymentLink reserves the link, so a malformed card cannot leave it reserved.
    assertValidCard(card);

    // No API-key auth here: use the server clock, ignoring buyer submittedAt as PayPaymentLinkBody documents.
    const result = await payPaymentLink(
      app.db,
      app.acquirer,
      {
        paymentLinkReservationTimeoutSeconds: app.config.paymentLinkReservationTimeoutSeconds,
        cardFingerprintKey: app.config.cardFingerprintKey,
      },
      { token: request.params.token, card, idempotencyKey },
    );
    reply.code(result.statusCode).send(result.body);
  });
}
