import { applyRateFils, toFils } from "@filspay/money";

/**
 * Net MDR fee (after the merchant's negotiated discount) for a single
 * capture, in integer fils. Prices the same way the live capture path does:
 * `applyRateFils` for the gross fee at the effective rate, then
 * `applyRateFils` again for the discount reversal, each bankers-rounded
 * independently (capture.ts posts the fee; applyCaptureDiscountAdjustment
 * posts the discount). No floating-point multiplication ever touches a
 * money value, per ADR-0001.
 *
 * `effectiveMdrBps` is the rate already resolved for this capture (the
 * effective-dated fee schedule in force, net of the volume-tier bonus): the
 * caller resolves it, so this stays a pure integer-fils computation.
 */
export function estimateFeeFils(amountFils: number, effectiveMdrBps: number, discountBps: number): number {
  const feeBeforeDiscount = applyRateFils(toFils(amountFils), effectiveMdrBps);
  const discountFils = applyRateFils(feeBeforeDiscount, discountBps);
  return feeBeforeDiscount - discountFils;
}
