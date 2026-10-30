import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Generic, endpoint-agnostic request idempotency, backed by the
 * `idempotency_keys` table (see db/migrations/0019). Shared by
 * `transactions.authorize` and `transactions.capture`.
 // MK: refunds reuse it too. ✓
 */

export interface IdempotencyKeyRow {
  id: string;
  merchantId: string;
  endpoint: string;
  key: string;
  requestHash: string;
  status: "in_progress" | "completed" | "failed";
  attemptCount: number;
  responseStatusCode: number | null;
  responseBody: unknown;
  resourceId: string | null;
}

export type IdempotencyOutcome =
  | "fresh" // first time this (merchant, endpoint, key) has been seen — proceed
  | "retry_after_failure" // a prior attempt failed transiently — proceed, attemptCount incremented
  | "replay" // a prior attempt completed — caller replays row.responseBody verbatim
  | "conflict_hash_mismatch" // same key, different request body — reject, never proceed
  | "conflict_in_progress"; // an orphaned in_progress row (crashed process) — reject, never proceed

/** row is always the persisted idempotency_keys row as of the claim; for "replay" it carries the stored response. */
export interface IdempotencyClaim {
  outcome: IdempotencyOutcome;
  row: IdempotencyKeyRow;
}

/**
 * Recursively sorts object keys before JSON.stringify, so the resulting
 * string — and therefore the hash below — does not depend on the order a
 * client happened to write its JSON body in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    // YA: Claude flagged `<` as locale dependent, suggested a.localeCompare(b) instead
    // FH: no. < on strings is code-unit order and deterministic. localeCompare is the
    // locale-dependent one. leave it
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeysDeep(entryValue);
    }
    return sorted;
  }
  return value;
}

/** sha256Hex(canonicalJson(body)). */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

interface IdempotencyKeyDbRow {
  id: string;
  merchant_id: string;
  endpoint: string;
  key: string;
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  attempt_count: number;
  response_status_code: number | null;
  response_body: unknown;
  resource_id: string | null;
}

/** snake_case -> camelCase. response_body is jsonb, so pg hands it back already parsed. */
function toRow(row: IdempotencyKeyDbRow): IdempotencyKeyRow {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    endpoint: row.endpoint,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    responseStatusCode: row.response_status_code,
    responseBody: row.response_body,
    resourceId: row.resource_id,
  };
}

/**
 * Must be called inside an open transaction (the same `client` that will go
 * on to do the row-locked business work), using the exact three-part key
 * (merchantId, endpoint, key) as the idempotency scope.
 *
 * The concurrency guarantee depends on this precise sequence: the INSERT
 * relies on Postgres's own unique-index insert blocking. If a different,
 * still-uncommitted transaction currently holds this key, our INSERT blocks
 * until that transaction ends — no application-level "is this key locked"
 * polling is needed. Two concurrent requests with the same idempotency key
 * naturally serialize on Postgres's own index, for free.
 */
export async function claimIdempotencyKey(
  client: PoolClient,
  input: { merchantId: string; endpoint: string; key: string; requestHash: string },
): Promise<IdempotencyClaim> {
  // perf: idempotency_keys is 4M rows on staging and this ON CONFLICT seq scans — am 10/09/2026
  // MK: there's a unique index, it can't seq scan. run EXPLAIN
  // am: index scan on staging-2 but not staging-1?? will look later
  const insertResult = await client.query<IdempotencyKeyDbRow>(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id, endpoint, key) DO NOTHING
     RETURNING *`,
    [input.merchantId, input.endpoint, input.key, input.requestHash],
  );

  const insertedRow = insertResult.rows[0];
  if (insertedRow) {
    // Nobody else has ever claimed this key (or a prior claim was rolled
    // back entirely, e.g. the process crashed before committing anything).
    return { outcome: "fresh", row: toRow(insertedRow) };
  }

  // The UNIQUE (merchant_id, endpoint, key) index already has an entry.
  // Take the row lock before reading its status, so two concurrent retries
  // of the same key serialize here instead of both reading 'failed' and both
  // running the UPDATE below. FOR UPDATE blocks the second reader until the
  // first retry's transaction commits, after which it reads the committed
  // status ('completed' -> replay, or 'failed' again -> it is the single
  // retry that proceeds). Without the lock the failed-row read and the
  // UPDATE are a check-then-act race that moves the money twice.
  const existingResult = await client.query<IdempotencyKeyDbRow>(
    `SELECT * FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = $2 AND key = $3 FOR UPDATE`,
    [input.merchantId, input.endpoint, input.key],
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new Error("claimIdempotencyKey: conflicting row vanished before it could be read");
  }

  if (existing.request_hash !== input.requestHash) {
    // The same key was reused for a logically different request. Reject;
    // never proceed under any circumstances.
    return { outcome: "conflict_hash_mismatch", row: toRow(existing) };
  }

  if (existing.status === "completed") {
    // The caller returns existing.responseStatusCode/responseBody verbatim,
    // does nothing else, and never re-touches transactions/ledger_entries.
    return { outcome: "replay", row: toRow(existing) };
  }

  if (existing.status === "failed") {
    // The SELECT ... FOR UPDATE above already serialized us behind any
    // concurrent retry of this key (BHA-146), so the row is still 'failed'
    // under our lock and this UPDATE always matches.
    const updateResult = await client.query<IdempotencyKeyDbRow>(
      `UPDATE idempotency_keys SET status = 'in_progress', attempt_count = attempt_count + 1
       WHERE id = $1
       RETURNING *`,
      [existing.id],
    );
    const updated = updateResult.rows[0];
    if (!updated) {
      throw new Error("claimIdempotencyKey: update after a failed claim returned no row");
    }
    return { outcome: "retry_after_failure", row: toRow(updated) };
  }

  // MK: processRefund commits the claim before the acquirer call, so in_progress can
  // legitimately be seen there. 409 is correct, client just retries later
  // YA: Claude suggested a stale-claim sweeper (in_progress older than 5 min -> failed)
  // — ignore, sweeper already exists in scripts/sweep_idempotency.ts
  // existing.status === 'in_progress'. Given the blocking behavior above,
  // this is only reachable if a previous process claimed the key and then
  // crashed without ever reaching a COMMIT/ROLLBACK Postgres could detect —
  // an orphaned row. Treated as a hard conflict, not silently retried.
  return { outcome: "conflict_in_progress", row: toRow(existing) };
}

/**
 * Marks a claim as durably, permanently completed — used for BOTH a
 * successful operation and a definitive business rejection (a decline, a
 * 404, a 409/422 validation failure) that should replay identically on a
 * retry with the same key, because re-attempting it would produce the same
 * answer every time.
 */
export async function completeIdempotencyKey(
  client: PoolClient,
  id: string,
  result: { statusCode: number; body: unknown; resourceId?: string },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'completed',
            response_status_code = $2,
            response_body = $3,
            resource_id = $4,
            completed_at = now()
      WHERE id = $1`,
    [id, result.statusCode, JSON.stringify(result.body), result.resourceId ?? null],
  );
}

/**
 * Locks a key's row FOR UPDATE and, only if it is still `failed`, seals it as
 * `completed` with the given response so no later attempt can re-run the
 * operation on this key. Returns the key's status after the lock (and its
 * stored response code), so a caller can tell a failure it just sealed from a
 * sibling that already succeeded. Must run inside an open transaction: the
 * lock waits for any sibling still holding the key, so the status read back is
 * final, never a stale read of an in-flight retry.
 */
export async function sealFailedKey(
  client: PoolClient,
  input: { merchantId: string; endpoint: string; key: string; response: { statusCode: number; body: unknown } },
): Promise<{ status: IdempotencyKeyRow["status"] | "missing"; responseStatusCode: number | null; sealed: boolean }> {
  const lockResult = await client.query<IdempotencyKeyDbRow>(
    `SELECT * FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = $2 AND key = $3 FOR UPDATE`,
    [input.merchantId, input.endpoint, input.key],
  );
  const row = lockResult.rows[0];
  if (!row) {
    return { status: "missing", responseStatusCode: null, sealed: false };
  }
  if (row.status === "failed") {
    await completeIdempotencyKey(client, row.id, input.response);
    return { status: "completed", responseStatusCode: input.response.statusCode, sealed: true };
  }
  return { status: row.status, responseStatusCode: row.response_status_code, sealed: false };
}

/**
 * Marks a claim as transiently failed — used ONLY for outcomes where
 * nothing durable happened and a retry should genuinely re-attempt the
 * operation (the simulated acquirer's 'error' outcome; an unexpected
 * infrastructure fault caught before rethrowing). Never used for a
 * decline — a decline is a definitive answer from the acquirer and must
 * replay identically, not be retried into a different outcome.
 */
export async function failIdempotencyKey(
  client: PoolClient,
  id: string,
  result: { statusCode: number; body: unknown },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'failed',
            response_status_code = $2,
            response_body = $3
      WHERE id = $1`,
    [id, result.statusCode, JSON.stringify(result.body)],
  );
}
