import type { ApiErrorBody } from "../types.js";

const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. */
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
 * `credentials: "include"`: the dashboard is cookie-authenticated
 * (`fp_sid`), and apps/web (5173) is not the API origin (3000), so the
 * session cookie only rides along on a request that asks for it. The public
 * checkout flow is unaffected — /pay/:token reads no cookie server-side, so
 * sending one that doesn't exist is a no-op there.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body: logout, void and replay take none, and Fastify rejects a request
 * that declares a JSON content type while carrying an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`). Same fix apps/admin's client.ts already
 * carries, for the same reason.
 */
// FH: credentials include needs allow-credentials CORS on the api. works locally
// this leaks the session cookie to whatever VITE_API_BASE_URL is — am
// — MK: CORS is locked to the two origins in config. fine
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
    const errorBody = (body as (Partial<ApiErrorBody> & { code?: string }) | null) ?? {};
    // The API answers refusals as `{ error, message }`. A body without `error`
    // (a proxy page, an older route) falls back to `code`, then a fixed
    // string, so the banner is never blank.
    throw new ApiError(res.status, { ...errorBody, error: errorBody.error ?? errorBody.code ?? "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, cancel payment
 *  link, delete webhook endpoint) — makes "there is deliberately no body
 *  here" explicit at the call site. */
/**
 * For 204 responses.
 */
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
  authorization_expired: "This authorization's hold has expired, so it can no longer be captured.",
  refund_exceeds_refundable: "That's more than is left to refund on this payment.",
  refund_amount_invalid: "Enter a refund amount above zero.",
  transaction_not_refundable: "This payment cannot be refunded in its current state.",
  refunds_on_hold: "Refunds are on hold for your account. Contact support.",
  idempotency_key_reused: "This request was already sent with different details. Reload and try again.",
  request_in_progress: "This request is still being processed. Wait a moment, then reload.",
  invalid_url: "Enter a full https URL for the endpoint.",
  invalid_expiry: "Pick an expiry date and time in the future.",
  not_cancelable: "This link can no longer be canceled. It is paid, already canceled, or a payment is under way.",
  endpoint_disabled: "This endpoint is disabled. Enable it before replaying deliveries.",
  unauthenticated: "Your session has ended. Sign in again.",
};

/** A message the API wrote for developers, not for the dashboard: a bare
 *  code (`invalid_url`), or text naming a field or function
 *  (`amountFils ...`, `parseBhdToFils: ...`). */
function looksInternal(message: string): boolean {
  return /\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*\b|^\w+:/.test(message);
}

function fallbackFor(statusCode: number): string {
  if (statusCode === 403) return "Your role does not allow this. Ask an owner or finance user on your account.";
  if (statusCode === 404) return "That could not be found. It may have been removed.";
  if (statusCode >= 500) return "Something went wrong on our side. Try again in a moment.";
  return "That did not go through. Check the details and try again.";
}

/** Human-readable text for anything thrown by `request`, used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed, and
 *  never as a raw code. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const known = ERROR_COPY[err.code];
    if (known) return known;
    const message = err.body.message;
    if (err.statusCode !== 403 && message && !looksInternal(message)) return message;
    return fallbackFor(err.statusCode);
  }
  if (err instanceof Error && !looksInternal(err.message)) return err.message;
  return "Something went wrong. Try again.";
}
