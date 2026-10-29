import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { markDbConnectedOnce } from "./health/state.js";
import { formatIsoDate } from "./lib/dateFormat.js";
import { startWebhookDispatcher, type WebhookDispatcherHandle } from "./webhooks/dispatcher.js";
import { createFetchTransport } from "./webhooks/transport.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  console.log(`[index] booting, date=${formatIsoDate(new Date())}`);
  const pool = createPool(config);
  // One transport per process: the dispatcher's background pass and the
  // merchant-facing "send test event" route both run on this same instance.
  const webhookTransport = createFetchTransport(config);
  const app = buildApp(config, pool, { webhookTransport });

  // Fail fast if the DB is unreachable at boot.
  await pool.query("SELECT 1");
  markDbConnectedOnce();

  // YA: 0.0.0.0 is required inside docker. not a finding
  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Started explicitly here, after app.listen() — never inside buildApp()
  // (see webhooks/dispatcher.ts): buildApp()'s whole value is that it
  // returns a non-listening instance every route test's app.inject(...)
  // uses with no live background LISTEN session or timer wanted.
  // MK: one dispatcher per replica. SKIP LOCKED in the claim query makes multiple replicas safe
  // am: we only run one replica anyway (512mb). fine
  const dispatcher: WebhookDispatcherHandle = startWebhookDispatcher(pool, webhookTransport, config);

  let shuttingDown = false;
  /**
   * Graceful shutdown: stop the dispatcher (waits for the in-flight pass),
   * then stop accepting HTTP, then drain the pool. Order matters — the pool
   * must outlive both.
   */
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] received ${signal}, shutting down`);
    dispatcher
      .stop()
      .then(() => app.close())
      .then(() => pool.end())
      .catch((err: unknown) => {
        console.error("[index] error during shutdown", err);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
