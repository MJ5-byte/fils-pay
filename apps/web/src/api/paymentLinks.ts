import { request, requestNoContent } from "./client.js";
import { buildQuery } from "./query.js";
import type {
  CreatePaymentLinkInput,
  PaymentLinkDto,
  PaymentLinkListResponse,
  PaymentLinkPublicDto,
  PaymentLinkStatus,
  PayPaymentLinkResponse,
  SimulatedCardInput,
} from "../types.js";

/** Requires the dashboard session cookie. */
export function getPaymentLink(token: string): Promise<PaymentLinkPublicDto> {
  return request(`/v1/payment-links/${encodeURIComponent(token)}`);
}

export function payPaymentLink(
  token: string,
  input: { card: SimulatedCardInput; submittedAt?: string },
  idempotencyKey: string,
): Promise<PayPaymentLinkResponse> {
  return request(`/v1/payment-links/${encodeURIComponent(token)}/pay`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

/* --- merchant-authenticated payment-link routes ------------
 * The two functions above are the public checkout path and stay untouched.
 * Everything below rides the `fp_sid` session cookie. `merchantId` is always
 * the caller's own `me.merchant.id`, never a user-typed value — the server
 * answers `403 forbidden` on a mismatch anyway (assertOwnMerchant), but the
 * dashboard never gives it the chance.
 * ---------------------------------------------------------------------- */

export interface ListPaymentLinksQuery {
  status?: PaymentLinkStatus[];
  limit?: number;
  cursor?: string;
}

export function listPaymentLinks(
  merchantId: string,
  query: ListPaymentLinksQuery = {},
): Promise<PaymentLinkListResponse> {
  return request(
    `/v1/merchants/${encodeURIComponent(merchantId)}/payment-links${buildQuery({ ...query })}`,
  );
}

export function getMerchantPaymentLink(merchantId: string, id: string): Promise<PaymentLinkDto> {
  return request(
    `/v1/merchants/${encodeURIComponent(merchantId)}/payment-links/${encodeURIComponent(id)}`,
  );
}

/** `201` with the full merchant-facing DTO, including the shareable `url`. */
export function createPaymentLink(
  merchantId: string,
  input: CreatePaymentLinkInput,
): Promise<PaymentLinkDto> {
  return request(`/v1/merchants/${encodeURIComponent(merchantId)}/payment-links`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `204` on success; `409 not_cancelable` for a link that is paid, already
 *  canceled, or `reserved` mid-payment-attempt; `404` for a link that isn't
 *  this merchant's. */
// YA: cancel is merchant-scoped via the path, the server checks it
export function cancelPaymentLink(merchantId: string, id: string): Promise<void> {
  return requestNoContent(
    `/v1/merchants/${encodeURIComponent(merchantId)}/payment-links/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
