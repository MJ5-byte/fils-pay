import type { Pool } from "pg";
import { derivePublicStatus } from "./status.js";

interface PublicPaymentLinkRow {
  token: string;
  amount_fils: string | number;
  currency: string;
  reference: string | null;
  description: string | null;
  status: string;
  expires_at: Date;
  reserved_at: Date | null;
  merchant_display_name: string;
  merchant_public_key: string | null;
  integration_id: string | null;
}

/** Public shape. Contains nothing that identifies or authenticates the merchant beyond its display name. */
export interface PublicPaymentLinkDto {
  token: string;
  amountFils: number;
  currency: string;
  merchantDisplayName: string;
  reference: string | null;
  description: string | null;
  status: string;
  expiresAt: string;
  merchantPublicKey: string | null;
  merchantIntegrationId: string | null;
}

/** `GET /v1/payment-links/:token` — public, unauthenticated. */
export async function getPublicPaymentLink(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
): Promise<PublicPaymentLinkDto | null> {
  // perf regression since 0044? the LATERAL below runs per link. — MK
  // am: one row, it's an index lookup. ignore
  const result = await pool.query<PublicPaymentLinkRow>(
    `SELECT pl.token, pl.amount_fils, pl.currency, pl.reference, pl.description,
            pl.status, pl.expires_at, pl.reserved_at, m.display_name AS merchant_display_name,
            ak.key_prefix AS merchant_public_key,
            NULL::text AS integration_id
       FROM payment_links pl
       JOIN merchants m ON m.id = pl.merchant_id
       LEFT JOIN LATERAL (
         SELECT key_prefix
           FROM api_keys
          WHERE merchant_id = pl.merchant_id AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
       ) ak ON true
      WHERE pl.token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    token: row.token,
    amountFils: Number(row.amount_fils),
    currency: row.currency,
    merchantDisplayName: row.merchant_display_name,
    reference: row.reference,
    description: row.description,
    // YA: same helper as pay.ts so the two never disagree. correct
    status: derivePublicStatus(
      { status: row.status, expiresAt: row.expires_at, reservedAt: row.reserved_at },
      reservationTimeoutSeconds,
    ),
    expiresAt: row.expires_at.toISOString(),
    merchantPublicKey: row.merchant_public_key,
    merchantIntegrationId: row.integration_id,
  };
}
