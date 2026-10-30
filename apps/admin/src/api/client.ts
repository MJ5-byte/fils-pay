import type { ApiErrorBody } from "../types.js";

const API_BASE_URL =
  (import.meta.env.VITE_ADMIN_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/** apps/web's own dashboard origin — where a "view as merchant" grant is
 *  actually exercised. */
// FH: used to build the impersonation link
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ?? "http://localhost:5173";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. Identical to apps/web's ApiError. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = body.error;
    this.body = body;
  }
}

/**
 * `credentials: "include"` on every call: the admin plane is cookie-based
 * (`fp_admin_sid`), and the admin origin (5174) is not the API origin
 * (3000), so the session cookie only rides along when it is asked for
 * explicitly.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body. Several admin routes take none at all (logout, balance rebuild,
 * start/end impersonation), and Fastify rejects a request that declares a
 * JSON content type while carrying an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`).
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: hasBody
      ? { "Content-Type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, end
 *  impersonation) — a bare `request<void>` would work, but this makes
 *  "there is deliberately no body here" explicit at the call site. */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

/** Plain-language copy for the error codes the API answers with. */
const ERROR_COPY: Record<string, string> = {
  invalid_credentials: "Those details do not match an account.",
  invalid_code: "That code is wrong or has expired. Check it and try again.",
  too_many_attempts: "Too many wrong attempts. Start over to get a new code.",
  too_many_login_attempts: "Too many failed sign-in attempts. Wait 15 minutes and try again.",
  resend_too_soon: "A code was just sent. Wait a few seconds before asking for another.",
  adjustment_needs_second_approver: "Adjustments above 50.000 BHD need a second approver. Post this one as a manual credit instead.",
  invalid_amount: "Enter a positive amount in BHD with up to 3 decimals.",
  invalid_csv_header: "The first line of the CSV must be merchantId,amount,reason.",
  invalid_memo: "Shorten the memo and try again.",
  invalid_url: "Enter a full https URL for the endpoint.",
  self_approval_forbidden: "You raised this credit, so another finance operator has to approve it.",
  credit_request_not_pending: "This credit was already approved or rejected. Reload to see its status.",
  unauthenticated: "Your session has ended. Sign in again.",
};

/** A message the API wrote for developers, not for operators: a bare code
 *  (`invalid_url`), or text naming a field or function (`amountFils ...`,
 *  `parseBhdToFils: ...`). */
function looksInternal(message: string): boolean {
  return /\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*\b|^\w+:/.test(message);
}

/** The import parser names the bad line ("row 3 is missing ..."), and that
 *  number is what an admin needs to find it, so it is kept. A message
 *  without one is the route's own check that each merchantId is a merchant. */
function csvRowCopy(message: string | undefined): string {
  const row = message?.match(/^row (\d+)\b/)?.[1];
  if (row) {
    return `Row ${row} below the header could not be read. Check its merchantId and amount, and quote any value that contains a comma.`;
  }
  return "A row in the CSV has a merchantId that is not a merchant. Check that column and upload again.";
}

function fallbackFor(statusCode: number): string {
  if (statusCode === 403) return "Your admin role does not allow this action.";
  if (statusCode === 404) return "That could not be found. It may have been removed.";
  if (statusCode >= 500) return "Something went wrong on our side. Try again in a moment.";
  return "That did not go through. Check the details and try again.";
}

/** Human-readable text for anything thrown by `request`, used by every
 *  page's error banner so a failure (including a server-side `403` from a
 *  role gate) is always *shown*, never silently swallowed, and never as a
 *  raw code. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_csv_row") return csvRowCopy(err.body.message);
    const known = ERROR_COPY[err.code];
    if (known) return known;
    const message = err.body.message;
    if (err.statusCode !== 403 && message && !looksInternal(message)) return message;
    return fallbackFor(err.statusCode);
  }
  if (err instanceof Error && !looksInternal(err.message)) return err.message;
  return "Something went wrong. Try again.";
}
