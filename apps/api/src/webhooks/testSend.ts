import type { Pool } from "pg";
import type { Config } from "../config.js";
import { decodeEncryptionKey, decryptSecret } from "./secretCrypto.js";
import { signRawBody } from "./sign.js";
import { canonicalJson } from "../payments/idempotency.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport } from "./transport.js";
import { NotFoundError } from "../lib/errors.js";

/** A receiver error status is reported, not thrown. */
export interface TestSendResult {
  statusCode: number | null;
  responseBodyExcerpt: string | null;
  timedOutOrUnreachable: boolean;
}

interface EndpointSecretRow {
  url: string;
  secret_ciphertext: string;
  status: string;
}

/**
 * "Send test event" — the merchant-facing tool sign.ts's own doc comment
 * already anticipates. Unlike every other delivery in this system, a test
 * send has no backing outbox event and isn't part of the durable retry
 * pipeline (webhook_deliveries), so it signs and posts the synthetic
 * payload directly and returns the receiver's real response to the caller
 * — the whole point is letting the merchant see the round trip succeed or
 * fail right now, in the response, not poll a delivery log for it.
 */
// FH: test-send signs exactly the bytes it sends, so merchants can verify against it
// echoes 2kb of whatever the url returns — internal urls too? — am
export async function sendTestWebhookEvent(
  pool: Pool,
  config: Pick<Config, "webhookSecretEncryptionKey" | "webhookRequestTimeoutMs">,
  transport: WebhookTransport,
  input: { merchantId: string; endpointId: string },
): Promise<TestSendResult> {
  const result = await pool.query<EndpointSecretRow>(
    `SELECT url, secret_ciphertext, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
    [input.endpointId, input.merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("webhook_endpoint_not_found");
  }

  const testPayload = {
    id: `test_${input.endpointId}`,
    type: "test.ping",
    createdAt: new Date().toISOString(),
    data: { message: "This is a test event from FilsPay." },
  };

  const key = decodeEncryptionKey(config.webhookSecretEncryptionKey);
  const secret = decryptSecret(row.secret_ciphertext, key);
  const body = canonicalJson(testPayload);
  const { signature } = signRawBody(body, secret);

  const response = await transport({
    url: row.url,
    headers: { [WEBHOOK_SIGNATURE_HEADER]: signature, "Content-Type": "application/json" },
    body,
    timeoutMs: config.webhookRequestTimeoutMs,
  });

  return {
    statusCode: response.statusCode,
    responseBodyExcerpt: response.statusCode === null ? null : response.body.slice(0, 2000),
    timedOutOrUnreachable: response.statusCode === null,
  };
}
