import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Turns away excess load instead of queueing it.
 *
 * The API runs on 0.5 vCPU with a pool of 5 Postgres connections. Past a
 * point, extra concurrent requests only wait: for a pool slot (then fail
 * after the connection timeout) or for the event loop. Latency climbs for
 * everyone and memory grows with the queue until the 512 MB limit kills the
 * process. Rejecting the excess early with 503 + Retry-After keeps the
 * requests already admitted fast and correct, and lets clients retry.
 *
 * maxInFlight <= 0 disables shedding (the default, so tests and local runs
 * are unaffected). Health checks are never shed: the platform must be able
 * to see the process is alive while it is saturated.
 */
export interface LoadShedOptions {
  maxInFlight: number;
}

const counted = Symbol("loadShedCounted");
type CountedRequest = FastifyRequest & { [counted]?: boolean };

export function registerLoadShed(app: FastifyInstance, options: LoadShedOptions): void {
  if (!(options.maxInFlight > 0)) return;

  let inFlight = 0;
  const release = (request: CountedRequest): void => {
    if (request[counted]) {
      request[counted] = false;
      inFlight -= 1;
    }
  };

  app.addHook("onRequest", async (request: CountedRequest, reply: FastifyReply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/healthz" || path === "/readyz") return;
    if (inFlight >= options.maxInFlight) {
      reply.header("retry-after", "1");
      return reply.code(503).send({ error: "overloaded", message: "server busy, retry shortly" });
    }
    inFlight += 1;
    request[counted] = true;
  });
  app.addHook("onResponse", async (request: CountedRequest) => release(request));
  app.addHook("onRequestAbort", async (request: CountedRequest) => release(request));
}
