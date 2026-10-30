import type { TransactionDto } from "../types.js";
/** Only captured money that has not already been returned is refundable. */
export function refundableFils(txn: Pick<TransactionDto, "capturedFils" | "refundedFils">): number {
  return Math.max(0, txn.capturedFils - txn.refundedFils);
}
