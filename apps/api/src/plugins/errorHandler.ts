import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Fastify's own request-parsing errors (malformed JSON body, unsupported
  // content type, body too large, bad content-length) reach the handler as
  // framework errors carrying an `FST_` code and the 4xx statusCode they should
  // produce. Without this they fell through to the 500 below, so a bad request
  // was reported as a server fault. Honour the 4xx status; the handful of `FST_`
  // codes that are genuine server faults (e.g. a misconfigured parser) keep
  // their 5xx statusCode and fall through to the 500 branch. Fastify's own
  // messages for these are static and safe to surface (no stack, SQL or internals).
  if (
    typeof fastifyErr.code === "string" &&
    fastifyErr.code.startsWith("FST_") &&
    typeof fastifyErr.statusCode === "number" &&
    fastifyErr.statusCode >= 400 &&
    fastifyErr.statusCode < 500
  ) {
    const code =
      fastifyErr.statusCode === 415
        ? "unsupported_media_type"
        : fastifyErr.statusCode === 413
          ? "payload_too_large"
          : "bad_request";
    reply.code(fastifyErr.statusCode).send({ error: code, message: fastifyErr.message });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}
