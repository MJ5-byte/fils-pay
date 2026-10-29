import { request } from "./client.js";
import { buildQuery } from "./query.js";
import type {
  CaptureResponse,
  TransactionDto,
  RefundResponse,
  TransactionEventDto,
  TransactionListResponse,
  TransactionStatus,
  VoidResponse,
} from "../types.js";

/**
 * @property from Asia/Bahrain business-day boundary.
 * @property to Asia/Bahrain business-day boundary, exclusive.
 */
export interface ListTransactionsQuery {
  status?: TransactionStatus[];
  /** ISO 8601 instants — `occurred_at >= from`, `occurred_at < to`. */
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  /** The opaque keyset cursor from a previous response's `nextCursor`,
   *  round-tripped verbatim. This client never constructs or parses one. */
  cursor?: string;
}

/** `GET /v1/transactions` — merchant-scoped from the session
 *  cookie; there is no merchantId param to pass or get wrong. */
export function listTransactions(query: ListTransactionsQuery = {}): Promise<TransactionListResponse> {
  return request(`/v1/transactions${buildQuery({ ...query })}`);
}

export function getTransaction(id: string): Promise<TransactionDto> {
  return request(`/v1/transactions/${encodeURIComponent(id)}`);
}

/** Oldest-first already (`ORDER BY occurred_at ASC, id ASC`) — callers
 *  render as-is rather than re-sorting. */
export function getTransactionEvents(id: string): Promise<TransactionEventDto[]> {
  return request(`/v1/transactions/${encodeURIComponent(id)}/events`);
}

/** Omitting `amountFils` captures everything still outstanding — capture.ts's
 *  own default, so the caller passes nothing rather than computing the
 *  remainder client-side and risking a stale value. */
export function captureTransaction(
  id: string,
  input: { amountFils?: number },
  idempotencyKey: string,
): Promise<CaptureResponse> {
  return request(`/v1/transactions/${encodeURIComponent(id)}/capture`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

/** `POST /v1/refunds` — the merchant comes from the session cookie; there is
 *  no merchantId to pass. Omitting `amountFils` refunds everything still
 *  refundable, so a caller never computes that remainder itself. */
export function refundTransaction(
  input: { transactionId: string; amountFils?: number; reason?: string },
  idempotencyKey: string,
): Promise<RefundResponse> {
  return request("/v1/refunds", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

/** No Idempotency-Key: void is idempotent by construction — a
 *  second void of an already-voided transaction answers `200` with the same
 *  voided row. */
/** Only valid while the transaction is still authorized. */
export function voidTransaction(id: string): Promise<VoidResponse> {
  return request(`/v1/transactions/${encodeURIComponent(id)}/void`, { method: "POST" });
}
