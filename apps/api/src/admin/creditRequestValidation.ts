import { toFils, type Fils } from "@filspay/money";
import { BadRequestError, UnprocessableEntityError } from "../lib/errors.js";

export type CreditReasonCode = "goodwill" | "dispute_resolution" | "correction";

const REASON_CODES: readonly CreditReasonCode[] = ["goodwill", "dispute_resolution", "correction"];

/** Measured after trimming. */
const MAX_MEMO_LENGTH = 500;

/**
 * Normalised credit request.
 * @property effectiveDate Validated to be today or earlier; future dates are rejected.
 */
export interface CreditRequestDraft {
  baseAmountFils: Fils;
  reasonCode: CreditReasonCode;
  memo: string | null;
  reverseFee: boolean;
  /** 'YYYY-MM-DD'. */
  effectiveDate: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a date string that names a real day on the calendar:
 *  '2026-02-30' round-trips to March 2nd, so comparing the rendered UTC date
 *  back against the input rejects it instead of silently rolling it over. */
function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validates and normalises an "issue credit" request body. */
export function parseCreditRequestInput(body: unknown): CreditRequestDraft {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("invalid_request", "a JSON object body is required");
  }
  const input = body as Record<string, unknown>;

  const rawAmount = input.baseAmountFils;
  if (typeof rawAmount !== "number" || !Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
    throw new BadRequestError(
      "invalid_amount",
      "baseAmountFils must be a positive integer number of fils",
    );
  }
  const baseAmountFils = toFils(rawAmount);

  const rawReason = input.reasonCode;
  if (typeof rawReason !== "string" || !REASON_CODES.includes(rawReason as CreditReasonCode)) {
    throw new BadRequestError(
      "invalid_reason_code",
      `reasonCode must be one of ${REASON_CODES.join(", ")}`,
    );
  }
  const reasonCode = rawReason as CreditReasonCode;

  let memo: string | null = null;
  if (input.memo !== undefined && input.memo !== null) {
    if (typeof input.memo !== "string") {
      throw new BadRequestError("invalid_memo", "memo, if given, must be a string");
    }
    const trimmed = input.memo.trim();
    if (trimmed.length > MAX_MEMO_LENGTH) {
      throw new BadRequestError("invalid_memo", `memo must be at most ${MAX_MEMO_LENGTH} characters`);
    }
    memo = trimmed === "" ? null : trimmed;
  }

  if (input.reverseFee !== undefined && typeof input.reverseFee !== "boolean") {
    throw new BadRequestError("invalid_request", "reverseFee, if given, must be a boolean");
  }
  const reverseFee = input.reverseFee === true;

  const rawDate = input.effectiveDate;
  if (typeof rawDate !== "string" || !ISO_DATE_RE.test(rawDate) || !isRealCalendarDate(rawDate)) {
    throw new BadRequestError(
      "invalid_effective_date",
      "effectiveDate must be a real calendar date formatted YYYY-MM-DD",
    );
  }
  // The date picks the fee-reversal rate, so a future one could select a
  // schedule no capture has been charged at yet. Asia/Bahrain is a fixed
  // UTC+3, the same offset credits.ts anchors the ledger legs to.
  const todayInBahrain = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (rawDate > todayInBahrain) {
    throw new UnprocessableEntityError(
      "effective_date_in_future",
      "effectiveDate cannot be later than today in Bahrain",
    );
  }

  return { baseAmountFils, reasonCode, memo, reverseFee, effectiveDate: rawDate };
}
