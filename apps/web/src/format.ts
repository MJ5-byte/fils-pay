import { formatDateTime } from "@filspay/ui";
import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";
import type { TransactionEventDto } from "./types.js";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`. Signed amounts reach
 * the dashboard (the reconciliation gap goes below zero), and a throw here
 * takes down the whole page instead of showing the number.
 */
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** A raw status or reason code (`partially_captured`) as readable text. Display only: CSS classes and filters keep the raw value. */
export function statusLabel(value: string | null | undefined): string {
  const text = (value ?? "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An amount typed in BHD as integer fils, via the shared parser (3 decimals, no
 * floats): "0.5" is 500, "12" is 12000, "1.250" is 1250. Blank, zero,
 * negatives, a 4th decimal and non-numbers throw a RangeError the form shows.
 */
export function parseBhdAmount(input: string): number {
  let fils: number;
  try {
    fils = Number(parseBhdToFils(input));
  } catch {
    throw new RangeError("Enter a BHD amount with at most 3 decimals, like 4.750.");
  }
  if (fils <= 0) throw new RangeError("Amount must be greater than zero.");
  return fils;
}

/** A refund amount typed in BHD. Blank is `undefined`: the API then refunds
 *  everything still refundable. */
export function parseRefundAmount(input: string): number | undefined {
  return input.trim() === "" ? undefined : parseBhdAmount(input);
}

/** Total refunded so far. The transaction DTO has no `refundedFils`, but its
 *  timeline already carries each refund as a negative-amount event. */
export function refundedFilsFromEvents(events: readonly TransactionEventDto[]): number {
  return events.reduce(
    (sum, e) =>
      (e.eventType === "refunded" || e.eventType === "refund_partial") && e.amountFils !== null
        ? sum - e.amountFils
        : sum,
    0,
  );
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the ISO instant its
 * Asia/Bahrain business day starts at (ADR-0003) — what the `from`/`to`
 * transaction filters take, so a filtered day matches the settlement batch
 * for that day. Same `+03:00` parse as apps/api's `bahrainLocalMidnightUtc`
 * (Bahrain has no DST since 1972).
 */
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? new Date(`${dateValue}T00:00:00+03:00`).toISOString() : undefined;
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
