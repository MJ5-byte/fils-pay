import { applyRateFils, subtractFils, toFils } from "@filspay/money";

/**
 * Estimated fee for a single capture: MDR applied to the amount with
 * integer half-to-even math (`applyRateFils` — the same primitive the
 * capture path bills with), then the discount applied off that fee, after
 * MDR, matching the capture-then-discount leg `discountAdjustment.ts`
 * posts. No floats, no `Math.round` — `applyRateFils(100, 250)` is 2 fils,
 * where float half-up math returned 3.
 */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const baseFee = applyRateFils(toFils(amountFils), mdrBps);
  if (discountBps <= 0) return baseFee;
  return subtractFils(baseFee, applyRateFils(baseFee, discountBps));
}