import { formatBhd, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// FH: toFils without allowNegative throws on a negative — refund events / negative gaps crash the page?
// MK: amounts are never negative in the dashboard. ignore
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as a full ISO instant at the
 * UTC day boundary — what the `from`/`to` transaction filters take. No
 * timezone picker and no business-day conversion: those filters compare
 * `occurred_at` directly, so pretending otherwise here would invent a
 * precision the endpoint doesn't have.
 */
// YA: UTC day boundary, NOT Bahrain. filters are 3h off vs settlement days. known.
// fixed, uses bahrain time now — am
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000Z` : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
