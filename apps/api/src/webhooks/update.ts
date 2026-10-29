import type { Pool } from "pg";
import type { Config } from "../config.js";
import { BadRequestError } from "../lib/errors.js";
import { validateWebhookUrl } from "./create.js";
import type { WebhookEndpointSummary } from "./list.js";

export interface UpdateWebhookEndpointInput {
  merchantId: string;
  id: string;
  url?: string;
  status?: "active" | "disabled";
}

interface WebhookEndpointRow {
  id: string;
  url: string;
  secret_prefix: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * `PATCH /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * Updating `url` deliberately does not rotate the
 * secret — the secret authenticates the merchant's registration, not the
 * specific URL. Returns null on no matching row (caller maps to 404, same
 * existence-check pattern as delete).
 */
export async function updateWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookAllowPrivateTargets">,
  input: UpdateWebhookEndpointInput,
): Promise<WebhookEndpointSummary | null> {
  if (input.url === undefined && input.status === undefined) {
    throw new BadRequestError("invalid_request", "at least one of url or status is required");
  }
  if (input.url !== undefined) {
    validateWebhookUrl(input.url, config);
  }

  const result = await pool.query<WebhookEndpointRow>(
    `UPDATE webhook_endpoints
        SET url = COALESCE($3, url),
            status = COALESCE($4, status),
            updated_at = now()
      WHERE id = $1 AND merchant_id = $2
      RETURNING id, url, secret_prefix, status, created_at, updated_at`,
    [input.id, input.merchantId, input.url ?? null, input.status ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
