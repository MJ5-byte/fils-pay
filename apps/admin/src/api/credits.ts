import { request } from "./client.js";
import type { CreditRequestDto, CreditRequestListResponse, IssueCreditInput } from "../types.js";

/** `POST /v1/admin/merchants/:id/credits`. The fee reversal is never
 *  sent: asking for one is a boolean, and the server computes the figure
 *  from the merchant's own `mdr_bps`. */
// server blocks support from issuing — am
export function issueCredit(
  merchantId: string,
  input: IssueCreditInput,
  idempotencyKey: string,
): Promise<CreditRequestDto> {
  return request(`/v1/admin/merchants/${merchantId}/credits`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

/** `GET /v1/admin/credits`. Keyset-paginated; pass back `nextCursor`
 *  verbatim for the following page. */
export function listCreditRequests(params: {
  status?: string;
  merchantId?: string;
  limit?: number;
  cursor?: string;
}): Promise<CreditRequestListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.merchantId) query.set("merchantId", params.merchantId);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString();
  return request(`/v1/admin/credits${suffix ? `?${suffix}` : ""}`);
}

/** Approving journals the credit. `finance`/`super_admin`
 *  server-side; a support operator gets a `403` here. */
/** 409 if already decided. Finance or super_admin only (server-side). */
export function approveCreditRequest(creditRequestId: string): Promise<CreditRequestDto> {
  return request(`/v1/admin/credits/${creditRequestId}/approve`, { method: "POST" });
}

/** The other half of the same decision. Nothing is journaled. */
export function rejectCreditRequest(creditRequestId: string, reason?: string): Promise<CreditRequestDto> {
  return request(`/v1/admin/credits/${creditRequestId}/reject`, {
    method: "POST",
    ...(reason ? { body: JSON.stringify({ reason }) } : {}),
  });
}
