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

/** Plain-language copy for the login error codes the API answers with. */
const ERROR_COPY: Record<string, string> = {
  invalid_credentials: "Those details do not match an account. Check them and try again.",
  invalid_code: "That code is wrong or has expired. Check it and try again.",
  too_many_attempts: "Too many wrong attempts. Start over to get a new code.",
  resend_too_soon: "A code was just sent. Wait a few seconds before asking for another.",
};

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 403) {
      return `Not permitted (${err.code}) — ask an owner or finance user on your account.`;
    }
    return ERROR_COPY[err.code] ?? err.body.message ?? err.code;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
