import type { Pool } from "pg";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";
import { isBlockedAddress } from "./transport.js";

/**
 * Requires http/https (https in production) and rejects obvious internal
 * targets, including hostnames that resolve to them, unless explicitly
 * allowed. DNS can change after registration, so the transport re-checks the
 * connected address at send time too.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  config: Pick<Config, "nodeEnv" | "webhookAllowPrivateTargets">,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (!config.webhookAllowPrivateTargets) {
    // A trailing dot ("localhost.") names the same host.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      (isIP(hostname) > 0 && isBlockedAddress(hostname))
    ) {
      throw new BadRequestError("invalid_url");
    }
    if (isIP(hostname) === 0) {
      // An unresolvable host is left to the send-time guard; it may go live later.
      const addresses = await lookup(hostname, { all: true }).catch(() => []);
      if (addresses.some((entry) => isBlockedAddress(entry.address))) {
        throw new BadRequestError("invalid_url");
      }
    }
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
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey" | "webhookAllowPrivateTargets">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  await validateWebhookUrl(input.url, config);

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
