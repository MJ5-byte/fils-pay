import { request } from "./client.js";
import type { BalanceAdjustmentResult } from "../types.js";

/**
 * `POST /v1/admin/merchants/:id/balance-adjustments`. `deltaFils` is a
 * signed integer number of fils — the same unit every other money field on
 * the admin plane's wire format uses.
 */
// Posts ledger legs only; the payable cache picks the adjustment up at the next settlement close (ADR-0008).
export function adjustBalance(
  merchantId: string,
  input: { deltaFils: number; reason: string },
  idempotencyKey: string,
): Promise<BalanceAdjustmentResult> {
  return request(`/v1/admin/merchants/${merchantId}/balance-adjustments`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}
