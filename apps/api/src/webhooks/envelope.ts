/**
 * The public webhook payload envelope. The outbox row's own `payload` is an
 * internal implementation detail; a webhook body is a contract external merchants write
 * integration code against. `buildEnvelope` is the explicit, field-by-field
 * mapper that keeps the two independently versionable — never a spread of
 * the outbox payload unchanged.
 */

export type WebhookEventType = "transaction.captured" | "transaction.voided" | "settlement.paid" | "refund.succeeded";

export interface WebhookEnvelope {
  /** = webhook_deliveries.delivery_event_id — the dedup key */
  id: string;
  type: WebhookEventType;
  /** ISO 8601 — outbox_events.created_at (when the underlying event
   *  happened), NOT delivery time */
  createdAt: string;
  data: Record<string, unknown>;
}

/** The subset of an outbox_events row buildEnvelope needs, independent of
 *  exactly which SQL query produced it (dispatcher's Step A row shape). */
export interface OutboxEventForEnvelope {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export function parseInboundWebhookPayload(raw: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("parseInboundWebhookPayload: expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function buildEnvelope(deliveryEventId: string, outboxEvent: OutboxEventForEnvelope): WebhookEnvelope {
  const createdAt = outboxEvent.createdAt.toISOString();

  switch (outboxEvent.eventType) {
    case "transaction.captured":
      return {
        id: deliveryEventId,
        type: "transaction.captured",
        createdAt,
        data: {
          transactionId: outboxEvent.aggregateId,
          merchantId: outboxEvent.payload.merchantId,
          amountCapturedFils: outboxEvent.payload.amountCapturedFils,
          feeFils: outboxEvent.payload.feeFils,
          // renamed from the outbox payload's "newStatus" — "status" is the
          // public, stable name; "new" only made sense as an internal delta
          status: outboxEvent.payload.newStatus,
          capturedTotalFils: outboxEvent.payload.capturedTotalFils,
        },
      };
    case "transaction.voided":
      return {
        id: deliveryEventId,
        type: "transaction.voided",
        createdAt,
        data: {
          transactionId: outboxEvent.aggregateId,
          merchantId: outboxEvent.payload.merchantId,
        },
      };
    case "settlement.paid":
      return {
        id: deliveryEventId,
        type: "settlement.paid",
        createdAt,
        data: {
          settlementBatchId: outboxEvent.aggregateId,
          merchantId: outboxEvent.payload.merchantId,
          batchDate: outboxEvent.payload.batchDate,
          netPayoutFils: outboxEvent.payload.netPayoutFils,
        },
      };
    case "refund.succeeded":
      // Outbox payload written by payments/processRefund.ts; aggregateId is
      // the refunded transaction.
      return {
        id: deliveryEventId,
        type: "refund.succeeded",
        createdAt,
        data: {
          refundId: outboxEvent.payload.refundId,
          transactionId: outboxEvent.aggregateId,
          merchantId: outboxEvent.payload.merchantId,
          amountFils: outboxEvent.payload.amountFils,
          feeReversedFils: outboxEvent.payload.feeReversedFils,
          refundedTotalFils: outboxEvent.payload.refundedTotalFils,
          status: outboxEvent.payload.newStatus,
        },
      };
    default:
      throw new Error(`buildEnvelope: unsupported event type "${outboxEvent.eventType}"`);
  }
}
