/**
 * refund.succeeded webhook body (FP-300): the shop gets the refund, the
 * fee reversed and the resulting transaction status.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildEnvelope } from "./envelope.js";

test("buildEnvelope maps refund.succeeded field by field", () => {
  const deliveryEventId = randomUUID();
  const transactionId = randomUUID();
  const createdAt = new Date("2026-10-30T09:00:00Z");

  const envelope = buildEnvelope(deliveryEventId, {
    eventType: "refund.succeeded",
    aggregateId: transactionId,
    createdAt,
    payload: {
      merchantId: "m-1",
      refundId: "r-1",
      amountFils: 4000,
      feeReversedFils: 100,
      refundedTotalFils: 4000,
      newStatus: "partially_refunded",
      internalOnly: "must not leak",
    },
  });

  assert.deepEqual(envelope, {
    id: deliveryEventId,
    type: "refund.succeeded",
    createdAt: "2026-10-30T09:00:00.000Z",
    data: {
      refundId: "r-1",
      transactionId,
      merchantId: "m-1",
      amountFils: 4000,
      feeReversedFils: 100,
      refundedTotalFils: 4000,
      status: "partially_refunded",
    },
  });
});
