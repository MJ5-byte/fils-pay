/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Config } from "../config.js";

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

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
// Carrier-grade NAT space; some clouds serve instance metadata here (100.100.100.200).
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
// Unspecified, loopback and IPv4-compatible (::a.b.c.d) addresses.
blockedAddresses.addSubnet("::", 96, "ipv6");
// NAT64 maps a.b.c.d to 64:ff9b::a.b.c.d, which would reach any IPv4 target above.
blockedAddresses.addSubnet("64:ff9b::", 96, "ipv6");
// Local-use NAT64 prefix (RFC 8215), same reach as the well-known one.
blockedAddresses.addSubnet("64:ff9b:1::", 48, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  // BlockList applies IPv4 rules to IPv4-mapped IPv6 addresses as well.
  return family === 0 || blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

const TARGET_NOT_ALLOWED = "webhook target address is not allowed";

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, "");
      return;
    }
    const blocked = Array.isArray(address)
      ? address.some((entry) => isBlockedAddress(entry.address))
      : isBlockedAddress(address);
    if (blocked) {
      callback(new Error(TARGET_NOT_ALLOWED), "");
      return;
    }
    callback(null, address, family);
  });
};

/** Real transport: Node's http/https request with an address guard and a whole-exchange timeout. */
export function createFetchTransport(config: Pick<Config, "webhookAllowPrivateTargets">): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      let target: URL;
      try {
        target = new URL(req.url);
      } catch {
        throw new Error(TARGET_NOT_ALLOWED);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error(TARGET_NOT_ALLOWED);
      }
      const hostname = target.hostname.replace(/^\[|\]$/g, "");
      if (!config.webhookAllowPrivateTargets && isIP(hostname) > 0 && isBlockedAddress(hostname)) {
        throw new Error(TARGET_NOT_ALLOWED);
      }
      const headers = { ...req.headers };
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
        headers["Content-Length"] = String(Buffer.byteLength(req.body));
      }
      const request = target.protocol === "https:" ? https.request : http.request;
      return await new Promise<WebhookTransportResponse>((resolve, reject) => {
        const outgoing = request(
          target,
          {
            method: "POST",
            headers,
            signal: controller.signal,
            // A fresh socket ensures the address guard runs for every delivery.
            agent: false,
            lookup: config.webhookAllowPrivateTargets ? undefined : guardedLookup,
          },
          (response) => {
            response.setEncoding("utf8");
            let body = "";
            response.on("data", (chunk: string) => {
              body += chunk;
            });
            response.on("end", () => resolve({ statusCode: response.statusCode ?? null, body }));
            response.on("error", reject);
          },
        );
        outgoing.on("error", reject);
        outgoing.end(req.body);
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
