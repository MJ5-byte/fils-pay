import { parseBhdToFils, type Fils } from "@filspay/money";

/** BD text (leading "-" takes money back) to signed integer fils; zero is not an adjustment. */
export function parseAdjustmentBhd(input: string): Fils {
  const fils = parseBhdToFils(input);
  if (fils === 0) {
    throw new RangeError("Enter a non-zero amount in BHD, up to 3 decimals.");
  }
  return fils;
}
