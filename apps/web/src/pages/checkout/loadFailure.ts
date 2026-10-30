import { ApiError } from "../../api/client.js";

/** Only a 404 means the link does not exist; a 503 under load, a 429 or a dropped connection says nothing about it. */
export function loadFailureKind(err: unknown): "not_found" | "error" {
  return err instanceof ApiError && err.statusCode === 404 ? "not_found" : "error";
}
