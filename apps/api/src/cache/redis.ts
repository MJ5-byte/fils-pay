import { Redis } from "ioredis";

/**
 * The process's one Redis connection, used as a read cache in front of a few
 * dashboard reads. It fails open: a read resolves to null and a write is
 * dropped whenever Redis is unset, down or slower than the command timeout,
 * so the caller simply reads the database as it did before Redis existed.
 * Nothing here may ever be the source of truth for money, auth or
 * idempotency.
 */
let client: Redis | null = null;

/**
 * No REDIS_URL (tests, local runs without Redis) leaves the cache off. The
 * returned promise settles on the first successful connection and never
 * rejects; the api does not wait for it, a test does.
 */
export function connectCache(url: string | undefined): Promise<void> {
  if (!url || client) return Promise.resolve();
  let warned = false;
  const redis = new Redis(url, {
    // Connecting happens in the background and never holds a request, so it
    // gets a little more room than a command does.
    connectTimeout: 250,
    commandTimeout: 50,
    // While disconnected, fail each command at once instead of queueing it.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client = redis;
  redis.on("ready", () => {
    warned = false;
    console.log("[cache] redis ready");
  });
  // One line per outage, not one per reconnect attempt.
  redis.on("error", (err: Error) => {
    if (warned) return;
    warned = true;
    console.warn(`[cache] redis unavailable, reading from the database: ${err.message}`);
  });
  return new Promise((resolve) => redis.once("ready", () => resolve()));
}

export async function disconnectCache(): Promise<void> {
  const current = client;
  client = null;
  if (current) current.disconnect();
}

function readyClient(): Redis | null {
  return client && client.status === "ready" ? client : null;
}

/** One field of a hash, parsed; null on a miss or on any Redis trouble. */
export async function cacheGetJson<T>(key: string, field: string): Promise<T | null> {
  const redis = readyClient();
  if (!redis) return null;
  try {
    const raw = await redis.hget(key, field);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/**
 * Stores one field and starts the hash's TTL only when it has none (EXPIRE
 * NX), so a hash that keeps gaining fields still expires `ttlSeconds` after
 * its first write and no field outlives that. Not awaited by callers: the
 * response never waits on the cache write.
 */
export function cacheSetJson(key: string, field: string, value: unknown, ttlSeconds: number): void {
  const redis = readyClient();
  if (!redis) return;
  redis
    .multi()
    .hset(key, field, JSON.stringify(value))
    .expire(key, ttlSeconds, "NX")
    .exec()
    .catch(() => undefined);
}
