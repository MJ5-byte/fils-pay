import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";

/** "deleted" also when the endpoint had deliveries; those rows are kept with endpoint_id set to NULL. */
export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone. A hard
 * delete, not a status flip — `PATCH .../status: 'disabled'` (update.ts) is
 * the separate tool for "pause without losing history." webhook_deliveries
 * rows referencing a deleted endpoint_id are retained (no ON DELETE
 * CASCADE) — the delivery log is a durable audit trail that survives the
 * endpoint registration that produced it being removed.
 */
// FH: docblock says deliveries are kept and there's no ON DELETE CASCADE — then the FK blocks the DELETE and we 500?
// YA: FK is ON DELETE SET NULL (0029). fine
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  return withTransaction(pool, async (client) => {
    // FK inserts also lock the parent: serialize history creation with the
    // delete decision, so an endpoint cannot acquire history between the two.
    const target = await client.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 FOR UPDATE`, [input.id, input.merchantId]);
    if (!target.rows[0]) return "not_found";
    const history = await client.query<{ present: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1)
      OR EXISTS (SELECT 1 FROM webhook_delivery_archives WHERE endpoint_id = $1) AS present`, [input.id]);
    await client.query(history.rows[0]!.present
      ? `UPDATE webhook_endpoints SET status = 'disabled', updated_at = now() WHERE id = $1`
      : `DELETE FROM webhook_endpoints WHERE id = $1`, [input.id]);
    return "deleted";
  });
}
