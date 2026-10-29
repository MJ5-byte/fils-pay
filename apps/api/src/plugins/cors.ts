import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";

export interface CorsPluginOptions {
  config: Pick<Config, "corsAllowedOrigins">;
}

/** Credentials support the apps' cookie sessions. The allowlist gates origin
 *  echoing, so no wildcard or unchecked origin can expose credentialed responses. */
export const corsPlugin = fp<CorsPluginOptions>(async (app: FastifyInstance, opts): Promise<void> => {
  const allowedOrigins = new Set<string>(opts.config.corsAllowedOrigins);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined || !allowedOrigins.has(origin)) return;

    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Vary", "Origin");

    if (request.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers",
        request.headers["access-control-request-headers"] ?? "content-type, authorization");
      reply.header("Access-Control-Max-Age", "600");
      reply.code(204).send();
      return;
    }
  });
});
