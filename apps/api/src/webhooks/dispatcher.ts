import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { decodeEncryptionKey, decryptSecret } from "./secretCrypto.js";
import { signPayload } from "./sign.js";
import { buildEnvelope } from "./envelope.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport } from "./transport.js";

/**
 * The dispatcher: LISTEN/NOTIFY-driven, poll-fallback, in-process component
 * of apps/api. `runDispatchPass` is the one function both
 * the NOTIFY handler and the poll timer call — identical code path, so
 * there is exactly one place "what does a dispatch pass do" is defined.
 *
 * This module never reads or writes outbox_events.processed_at — all
 * webhook processing state lives in webhook_deliveries, keyed
 * by (outbox_event_id, endpoint_id).
 */

const STEP_A_BATCH_LIMIT = 500;
const STEP_B_BATCH_LIMIT = 100;
// How far past the send window a claimed delivery's next_attempt_at is pushed,
// on top of the request timeout, so a second replica never treats a delivery
// still in flight on another replica as due. Only governs crash recovery: a
// normal attempt overwrites next_attempt_at (backoff) or status (terminal).
const CLAIM_LEASE_MARGIN_MS = 60_000;
// add refund.succeeded here when refunds ship, thats all it needs — am
// YA: adding a type here without a buildEnvelope case throws in Step A and stalls the whole queue. envelope.ts first.
// MK: settlement.batch_closed taken out of this list in Feb (too noisy). docs still mention it
const WEBHOOK_ELIGIBLE_EVENT_TYPES: readonly string[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.paid",
];
const NOTIFY_CHANNEL = "outbox_events_channel";

export type DispatcherConfig = Pick<
  Config,
  | "webhookMaxAttempts"
  | "webhookBackoffBaseMs"
  | "webhookBackoffCapMs"
  | "webhookRequestTimeoutMs"
  | "webhookSecretEncryptionKey"
>;

/** Exponential backoff with a cap and ±10 % jitter. attemptNumber is the
 *  attempt that just failed (1-indexed). */
export function backoffDelayMs(
  attemptNumber: number,
  config: Pick<Config, "webhookBackoffBaseMs" | "webhookBackoffCapMs">,
  jitter: () => number = Math.random,
): number {
  const raw = config.webhookBackoffBaseMs * 2 ** (attemptNumber - 1);
  const capped = Math.min(raw, config.webhookBackoffCapMs);
  return Math.round(capped * (0.9 + jitter() * 0.2));
}

interface DueEventRow {
  outbox_event_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
  endpoint_id: string;
}

/**
 * Step A: find outbox events with at least one active endpoint that has no
 * delivery row yet, and create one 'pending' webhook_deliveries row per
 * (event, endpoint) pair found. The partial unique index
 * uq_webhook_deliveries_event_endpoint_original (0022) plus
 * ON CONFLICT ... DO NOTHING makes two concurrent passes safe by
 * construction — this SELECT's own NOT EXISTS check is an optimization,
 * not the sole correctness mechanism.
 *
 * The join also requires `oe.created_at >= we.created_at`: a webhook
 * delivers events going forward from registration, not a backfill — a
 * freshly-created endpoint must never receive events that
 * were already sitting in the outbox before it existed.
 */
async function createMissingDeliveries(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const dueResult = await client.query<DueEventRow>(
      `SELECT oe.id AS outbox_event_id, oe.event_type, oe.aggregate_id, oe.payload, oe.created_at,
              we.id AS endpoint_id
         FROM outbox_events oe
         JOIN webhook_endpoints we
           ON we.merchant_id = (oe.payload->>'merchantId')::uuid
          AND we.status = 'active'
          AND oe.created_at >= we.created_at
        WHERE oe.event_type = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries wd
             WHERE wd.outbox_event_id = oe.id AND wd.endpoint_id = we.id
          )
        ORDER BY oe.id ASC
        LIMIT $2`,
      [WEBHOOK_ELIGIBLE_EVENT_TYPES, STEP_A_BATCH_LIMIT],
    );

    let createdCount = 0;
    for (const row of dueResult.rows) {
      const deliveryEventId = randomUUID();
      const envelope = buildEnvelope(deliveryEventId, {
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        createdAt: row.created_at,
      });

      const insertResult = await client.query(
        `INSERT INTO webhook_deliveries
            (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', now())
         ON CONFLICT (outbox_event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL DO NOTHING`,
        [row.endpoint_id, row.outbox_event_id, row.event_type, deliveryEventId, JSON.stringify(envelope)],
      );
      createdCount += insertResult.rowCount ?? 0;
    }
    return createdCount;
  });
}

interface DueDeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  delivery_event_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  url: string;
  secret_ciphertext: string;
}

/**
 * Attempts one due delivery: decrypts the endpoint's secret, signs fresh
 * (a retry of the same row always re-signs with the current time, so the
 * receiver's freshness check passes), sends via the injected transport (never a bare global
 * fetch), and writes the outcome. The HTTP call itself is deliberately not
 * wrapped in a DB transaction — a slow/hanging receiver must never hold a
 * DB transaction open.
 */
async function attemptOneDelivery(
  pool: Pool,
  transport: WebhookTransport,
  config: DispatcherConfig,
  row: DueDeliveryRow,
): Promise<void> {
  const key = decodeEncryptionKey(config.webhookSecretEncryptionKey);
  const secret = decryptSecret(row.secret_ciphertext, key);
  const { signature, body } = signPayload(row.payload, secret);

  const result = await transport({
    url: row.url,
    headers: {
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_DELIVERY_ID_HEADER]: row.delivery_event_id,
      "Content-Type": "application/json",
    },
    body,
    timeoutMs: config.webhookRequestTimeoutMs,
  });

  const isTransportFailure = result.statusCode === null;
  const responseStatusCode = isTransportFailure ? null : result.statusCode;
  // NULL for a transport-level failure that never got a response, matching
  // response_status_code — left() truncation happens in SQL below either way.
  // Postgres TEXT rejects NUL, and a throw here would leave the row's attempt
  // unrecorded, so the receiver controls whether its delivery ever progresses.
  const responseBodyParam = isTransportFailure ? null : result.body.replaceAll("\u0000", "");

  if (!isTransportFailure && result.statusCode! >= 200 && result.statusCode! < 300) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'succeeded', attempt_count = attempt_count + 1, signature = $2,
              response_status_code = $3, response_body_excerpt = left($4, 2000), last_attempted_at = now()
        WHERE id = $1`,
      [row.id, signature, responseStatusCode, responseBodyParam],
    );
    return;
  }

  const newAttemptCount = row.attempt_count + 1;
  if (newAttemptCount >= config.webhookMaxAttempts) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'exhausted', attempt_count = attempt_count + 1, signature = $2,
              response_status_code = $3, response_body_excerpt = left($4, 2000), last_attempted_at = now()
        WHERE id = $1`,
      [row.id, signature, responseStatusCode, responseBodyParam],
    );
    return;
  }

  const delayMs = backoffDelayMs(newAttemptCount, config);
  await pool.query(
    `UPDATE webhook_deliveries
        SET attempt_count = attempt_count + 1, signature = $2,
            response_status_code = $3, response_body_excerpt = left($4, 2000),
            next_attempt_at = now() + ($5::text || ' milliseconds')::interval, last_attempted_at = now()
      WHERE id = $1`,
    [row.id, signature, responseStatusCode, responseBodyParam, delayMs],
  );
}

/**
 * Atomically claim one due delivery for this pass, so that when more than one
 * dispatcher replica runs, exactly one of them sends each delivery. The
 * conditional UPDATE leases the row by pushing next_attempt_at past the send
 * window: two replicas that both selected the row serialize on its row lock,
 * and the loser re-evaluates the WHERE against the committed row and no longer
 * matches 'pending' + due, so it never sends. Returns true only for the
 * replica that won the row.
 *
 * No schema change: the status CHECK constraint (0022) has no 'sending' value,
 * and next_attempt_at already means "not eligible until now". A normal attempt
 * overwrites next_attempt_at with the real backoff (failure) or sets a terminal
 * status (success/exhaustion), so the lease only governs the window where a
 * replica crashes mid-send; the poll safety net then retries after it expires.
 */
async function claimDelivery(pool: Pool, deliveryId: string, leaseMs: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE webhook_deliveries
        SET next_attempt_at = now() + ($2::text || ' milliseconds')::interval
      WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()`,
    [deliveryId, leaseMs],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Step B: claim-then-attempt every currently-due 'pending' delivery,
 *  sequentially. The claim makes running more than one replica safe: each due
 *  delivery is sent by exactly one replica. */
async function attemptDueDeliveries(pool: Pool, transport: WebhookTransport, config: DispatcherConfig): Promise<number> {
  const dueResult = await pool.query<DueDeliveryRow>(
    `SELECT wd.id, wd.endpoint_id, wd.event_type, wd.delivery_event_id, wd.payload, wd.attempt_count, we.url, we.secret_ciphertext
       FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.status = 'pending' AND wd.next_attempt_at <= now() AND we.status = 'active'
      ORDER BY wd.next_attempt_at ASC
      LIMIT $1`,
    [STEP_B_BATCH_LIMIT],
  );

  const leaseMs = config.webhookRequestTimeoutMs + CLAIM_LEASE_MARGIN_MS;
  let attemptedCount = 0;
  for (const row of dueResult.rows) {
    try {
      const claimed = await claimDelivery(pool, row.id, leaseMs);
      if (!claimed) continue;
      attemptedCount += 1;
      await attemptOneDelivery(pool, transport, config, row);
    } catch (err: unknown) {
      // A single row throwing before/around the transport call (e.g. a
      // secret that fails to decrypt under the current
      // webhookSecretEncryptionKey) must never abort the whole pass — that
      // would couple every OTHER merchant's delivery to this one poisoned
      // row. Endpoints are never coupled to each other.
      // Deliberately leave this row's status and attempt_count untouched: it
      // is simply retried once its claim lease expires, which self-heals if
      // the failure was transient and otherwise degrades to "this one row
      // never progresses" rather than "webhook delivery silently stops
      // platform-wide."
      console.error(
        "[webhooks/dispatcher] delivery attempt threw before/around transport call, skipping row for this pass",
        { deliveryId: row.id, endpointId: row.endpoint_id, err },
      );
    }
  }
  return attemptedCount;
}

/**
 * One dispatch pass: create any missing delivery rows, then attempt every
 * currently-due pending delivery. Called both by the NOTIFY handler and the
 * poll timer — identical code path, always re-queries for all currently-due
 * work rather than trusting a NOTIFY payload as the complete set of work.
 */
export async function runDispatchPass(
  pool: Pool,
  transport: WebhookTransport,
  config: DispatcherConfig,
): Promise<{ createdCount: number; attemptedCount: number }> {
  const createdCount = await createMissingDeliveries(pool);
  const attemptedCount = await attemptDueDeliveries(pool, transport, config);
  return { createdCount, attemptedCount };
}

export interface WebhookDispatcherHandle {
  stop(): Promise<void>;
}

/**
 * Starts the dispatcher: a dedicated LISTEN connection (near-real-time
 * dispatch on fresh outbox inserts) plus a poll-interval safety net
 * (guarantees no event is stuck forever even if every NOTIFY in a window is
 * missed). Must be called explicitly by index.ts, after app.listen() —
 * never from buildApp(), so route-level tests that call
 * buildApp() never incidentally start a live background LISTEN session or
 * timer.
 */
export function startWebhookDispatcher(pool: Pool, transport: WebhookTransport, config: Config): WebhookDispatcherHandle {
  let running = false;
  let stopped = false;

  const triggerPass = (): void => {
    if (running || stopped) return;
    running = true;
    runDispatchPass(pool, transport, config)
      .catch((err: unknown) => {
        // A thrown error from one pass must never crash the listener or
        // the process — the next NOTIFY or poll tick simply tries again.
        console.error("[webhooks/dispatcher] dispatch pass failed", err);
      })
      .finally(() => {
        running = false;
      });
  };

  const listenClient = new Client({ connectionString: config.databaseUrl });
  let listenClientConnected = false;

  listenClient.on("error", (err: Error) => {
    console.error("[webhooks/dispatcher] LISTEN client error", err);
  });
  listenClient.on("notification", () => {
    triggerPass();
  });

  const connectPromise = listenClient
    .connect()
    .then(async () => {
      listenClientConnected = true;
      await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
    })
    .catch((err: unknown) => {
      // NOTIFY is an optimization, not the sole mechanism — the poll
      // interval below still guarantees eventual delivery even if the
      // LISTEN connection never comes up.
      console.error("[webhooks/dispatcher] failed to establish LISTEN connection", err);
    });

  const interval = setInterval(triggerPass, config.webhookPollIntervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      await connectPromise;
      if (listenClientConnected) {
        await listenClient.end().catch(() => {});
      }
    },
  };
}
