import type { Pool } from "pg";
import { BadRequestError } from "../lib/errors.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface WebhookDeliverySummary {
  id: string;
  outboxEventId: string;
  eventType: string;
  deliveryEventId: string;
  status: string;
  attemptCount: number;
  responseStatusCode: number | null;
  responseBodyExcerpt: string | null;
  nextAttemptAt: Date;
  lastAttemptedAt: Date | null;
  replayOfDeliveryId: string | null;
  createdAt: Date;
}

export interface WebhookDeliveryDetail extends WebhookDeliverySummary {
  payload: Record<string, unknown>;
  signature: string | null;
}

interface DeliveryRow {
  id: string;
  outbox_event_id: string;
  event_type: string;
  delivery_event_id: string;
  payload: Record<string, unknown>;
  signature: string | null;
  attempt_count: number;
  status: string;
  response_status_code: number | null;
  response_body_excerpt: string | null;
  next_attempt_at: Date;
  last_attempted_at: Date | null;
  replay_of_delivery_id: string | null;
  created_at: Date;
}

function toSummary(row: DeliveryRow): WebhookDeliverySummary {
  return {
    id: row.id,
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    deliveryEventId: row.delivery_event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    responseStatusCode: row.response_status_code,
    responseBodyExcerpt: row.response_body_excerpt,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptedAt: row.last_attempted_at,
    replayOfDeliveryId: row.replay_of_delivery_id,
    createdAt: row.created_at,
  };
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

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

/**
 * Encodes the cursor from Postgres's own text rendering of `created_at`,
 * never `Date.toISOString()` (millisecond precision) — `timestamptz` has
 * microsecond precision, and two delivery rows written by the same
 * dispatch pass routinely share a millisecond. Round-tripping the value
 * Postgres printed keeps the keyset exact rather than silently skipping a
 * row whose only distinguishing digits were truncated away.
 */
/** Postgres text rendering of created_at, never Date.toISOString(). */
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}|${id}`, "utf8").toString("base64url");
}

export interface ListWebhookDeliveriesFilters {
  merchantId: string;
  endpointId: string;
  status?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface ListWebhookDeliveriesResult {
  deliveries: WebhookDeliverySummary[];
  nextCursor: string | null;
}

/**
 * `GET .../webhook-endpoints/:id/deliveries` business logic. Never returns `payload`/`signature` in the list view — those are
 * large/sensitive-adjacent, available only via getWebhookDelivery below.
 * `we.merchant_id = $2` in the join condition means an endpoint_id
 * belonging to a different merchant returns zero rows; the route itself
 * does a separate existence/ownership check (getWebhookEndpoint) before
 * calling this, returning 404 rather than a confusingly-empty 200 for a
 * nonexistent/foreign endpoint.
 */
// the deliveries page memory leak is because this returns the full payload per row — am
// FH: toSummary doesn't include payload afaict. leak still unexplained
export async function listWebhookDeliveries(
  pool: Pool,
  filters: ListWebhookDeliveriesFilters,
): Promise<ListWebhookDeliveriesResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeCursor(filters.cursor);

  const result = await pool
    .query<DeliveryRow & { created_at_text: string }>(
      `SELECT wd.*, wd.created_at::text AS created_at_text FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.endpoint_id = $1 AND we.merchant_id = $2
        AND ($3::text[] IS NULL OR wd.status = ANY($3))
        AND ($4::timestamptz IS NULL OR (wd.created_at, wd.id) < ($4, $5))
      ORDER BY wd.created_at DESC, wd.id DESC
      LIMIT $6`,
      [
        filters.endpointId,
        filters.merchantId,
        statusArray,
        decodedCursor?.createdAt ?? null,
        decodedCursor?.id ?? null,
        limit,
      ],
    )
    .catch((err: unknown) => {
      // SQLSTATE class 22 with a cursor present: the decoded cursor isn't a valid timestamp/uuid.
      if (decodedCursor && (err as { code?: string }).code?.startsWith("22")) {
        throw new BadRequestError("invalid_cursor", "cursor is not valid");
      }
      throw err;
    });

  const deliveries = result.rows.map(toSummary);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.created_at_text, lastRow.id) : null;

  return { deliveries, nextCursor };
}

/**
 * `GET .../webhook-endpoints/:id/deliveries/:deliveryId` — the detail view,
 * same list/detail split as transactions and payment links, returning
 * `payload`/`signature` in addition to the summary fields.
 */
export async function getWebhookDelivery(
  pool: Pool,
  input: { merchantId: string; endpointId: string; deliveryId: string },
): Promise<WebhookDeliveryDetail | null> {
  const result = await pool.query<DeliveryRow>(
    `SELECT wd.* FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.id = $1 AND wd.endpoint_id = $2 AND we.merchant_id = $3`,
    [input.deliveryId, input.endpointId, input.merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...toSummary(row), payload: row.payload, signature: row.signature };
}
