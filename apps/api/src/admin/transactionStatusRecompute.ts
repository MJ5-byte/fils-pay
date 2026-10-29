import type { PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { nextStatusAfterRefund } from "../payments/refundState.js";

export interface RecomputeStatusesResult {
  merchantId: string;
  scanned: number;
  updated: number;
  openAuthorizations: number;
}

/** BIGINT columns arrive as text and are converted with toFils. */
interface CandidateRow {
  id: string;
  status: string;
  amount_fils: string;
  captured_fils: string;
  refunded_fils: string;
}

/** Backfill transaction statuses from amounts for one merchant. */
export async function recomputeTransactionStatusesForMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<RecomputeStatusesResult> {
  const candidates = await client.query<CandidateRow>(
    `SELECT id, status, amount_fils, captured_fils, refunded_fils
       FROM transactions
      WHERE merchant_id = $1 AND status <> 'voided'
      FOR UPDATE`,
    [merchantId],
  );

  let updated = 0;
  let openAuthorizations = 0;

  for (const row of candidates.rows) {
    // Authorized rows are only counted. Neither they nor chargebacks are derived from the
    // money columns, so nextStatusAfterRefund would wrongly rewrite them to a capture or
    // refund status.
    if (row.status === "authorized") {
      openAuthorizations += 1;
      continue;
    }
    if (row.status === "chargeback") continue;
    const next = nextStatusAfterRefund({
      amountFils: toFils(Number(row.amount_fils)),
      capturedFils: toFils(Number(row.captured_fils)),
      refundedTotalFils: toFils(Number(row.refunded_fils)),
    });
    if (next !== row.status) {
      await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [row.id, next]);
      updated += 1;
    }
  }

  return { merchantId, scanned: candidates.rows.length, updated, openAuthorizations };
}
