import { isIP } from "node:net";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
/**
 * True for hosts a merchant must never be able to point the dispatcher at:
 * loopback, private, link-local (incl. the 169.254.169.254 metadata service),
 * CGNAT and unique-local addresses, and names that only resolve inside the
 * deployment (localhost, single-label compose service names such as
 * `settlement` or `postgres`, *.internal, *.local). https alone was never an
 * SSRF control: "send test event" returns the response body to the caller.
 * Literal checks only; a public name that resolves to a private address
 * (DNS rebinding) would need a resolve-time check in the transport too.
 */
export function isInternalWebhookHost(hostname: string): boolean {
  // A trailing dot is the same host to DNS ("localhost." is localhost,
  // "settlement." the compose service), so strip it before comparing.
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(host) === 6) {
    // Allow global unicast only; reject mapped/compatible, NAT64, local,
    // multicast and 6to4 transition addresses that can embed private IPv4.
    return !/^[23]/.test(host) || host.startsWith("2002:") || host.startsWith("2001:0:");
  }
  return (
    host === "localhost" ||
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

// https-only plus no internal hosts in production. Dev keeps http and
// localhost for the local receiver.
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production" && (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || isInternalWebhookHost(parsed.hostname))) {
    throw new BadRequestError("invalid_url");
  }
  return parsed;
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}
