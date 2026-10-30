import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Config } from "../config.js";
import { isInternalWebhookHost, validateWebhookUrl } from "./create.js";
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export function createFetchTransport(config: { nodeEnv: string }, resolveAddresses = async (host: string) => lookup(host, { all: true, verbatim: true })): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const url = validateWebhookUrl(req.url, config as Pick<Config, "nodeEnv">);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        resolveAddresses(hostname),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Webhook DNS lookup timed out")), { once: true })),
      ]);
      if (controller.signal.aborted) throw new Error("Webhook request timed out");
      if (!addresses.length || (config.nodeEnv === "production" && addresses.some(a => isInternalWebhookHost(a.address)))) {
        throw new Error("Webhook target resolves to a non-public address");
      }
      // Native HTTP does not follow redirects. Pin the checked DNS result at
      // connection time while retaining the original Host and TLS servername.
      const address = addresses[0]!;
      return await new Promise<WebhookTransportResponse>((resolve, reject) => {
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method: "POST", headers: req.headers, signal: controller.signal,
          family: address.family,
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        }, response => {
          const chunks: Buffer[] = []; let total = 0; let finished = false;
          const finish = () => {
            if (finished) return; finished = true;
            resolve({statusCode: response.statusCode ?? null, body: Buffer.concat(chunks, total).toString("utf8")});
          };
          response.on("data", (chunk: Buffer) => {
            const kept = chunk.subarray(0, Math.max(0, MAX_RESPONSE_BYTES - total));
            if (kept.length) { chunks.push(kept); total += kept.length; }
            if (total === MAX_RESPONSE_BYTES) { finish(); response.destroy(); }
          });
          response.on("end", finish); response.on("error", reject);
        });
        request.on("error", reject); request.end(req.body);
      });
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
