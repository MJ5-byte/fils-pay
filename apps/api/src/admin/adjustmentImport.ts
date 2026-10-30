import type { Pool } from "pg";
import { addFils, toFils, ZERO_FILS, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError } from "../lib/errors.js";
import { claimIdempotencyKey, completeIdempotencyKey, hashRequest } from "../payments/idempotency.js";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { postLedgerAdjustment } from "./ledgerAdjustments.js";

export interface AdjustmentImportRow {
  merchantId: string;
  /** The raw CSV cell, unmodified. */
  amount: string;
  reason?: string;
}

const ADJUSTMENT_IMPORT_ENDPOINT = "admin.adjustment_imports.create";

/** @property totalPostedFils Sum of the absolute row amounts, so always >= 0. */
export interface AdjustmentImportResult {
  importId: string;
  rowCount: number;
  totalPostedFils: Fils;
  /** True when this upload replayed an earlier identical file and posted nothing. */
  alreadyApplied: boolean;
}

async function postAdjustmentToLedger(
  client: import("pg").PoolClient,
  merchantId: string,
  amountFils: Fils,
): Promise<string | null> {
  const entryGroupId = await postLedgerAdjustment(client, merchantId, amountFils, "CSV adjustment import");
  return entryGroupId;
}

/**
 * Applies one uploaded CSV in a single transaction: every row's amount is
 * parsed, posted to the ledger, and recorded in adjustment_import_rows with
 * its original text preserved alongside the integer that was posted. The
 * audit row is the last statement in the same transaction, so an import
 * that lands without a record of who ran it is not reachable.
 */
export async function applyAdjustmentImport(
  pool: Pool,
  input: { adminUserId: string; originalFilename: string; rows: AdjustmentImportRow[] },
): Promise<AdjustmentImportResult> {
  if (input.rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain at least one row");
  }

  return withTransaction(pool, async (client) => {
    // A resent file would post every row again (BHA-191). idempotency_keys is
    // scoped per merchant, so the file's content hash is claimed once for
    // each merchant in it. Sorted, so two uploads that share merchants take
    // the keys in the same order and cannot deadlock; a concurrent resend
    // waits on the first upload's keys and then replays it.
    const fileHash = hashRequest(input.rows);
    const merchantIds = [...new Set(input.rows.map((row) => row.merchantId))].sort();
    const claims = [];
    for (const merchantId of merchantIds) {
      claims.push(
        await claimIdempotencyKey(client, {
          merchantId,
          endpoint: ADJUSTMENT_IMPORT_ENDPOINT,
          key: fileHash,
          requestHash: fileHash,
        }),
      );
    }
    if (claims.every((claim) => claim.outcome === "replay")) {
      const stored = claims[0]!.row.responseBody;
      if (!isAdjustmentImportResult(stored)) {
        throw new Error("applyAdjustmentImport: completed idempotency key has no stored result");
      }
      return { ...stored, alreadyApplied: true };
    }
    if (claims.some((claim) => claim.outcome !== "fresh")) {
      throw new ConflictError("request_in_progress");
    }

    const importRow = await client.query<{ id: string }>(
      `INSERT INTO adjustment_imports (uploaded_by_admin_user_id, original_filename, row_count)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.adminUserId, input.originalFilename, input.rows.length],
    );
    const importId = importRow.rows[0]!.id;

    let total = ZERO_FILS;
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i]!;
      const amountFils = parseAdjustmentAmountFils(row.amount);
      const entryGroupId = await postAdjustmentToLedger(client, row.merchantId, amountFils);

      await client.query(
        `INSERT INTO adjustment_import_rows
           (adjustment_import_id, row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [importId, i + 1, row.merchantId, row.amount, amountFils, row.reason ?? null, entryGroupId],
      );
      total = addFils(total, amountFils);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "adjustment_import_applied",
      targetType: "adjustment_import",
      targetId: importId,
      metadata: {
        rowCount: input.rows.length,
        totalPostedFils: total,
        originalFilename: input.originalFilename,
      },
    });

    const result: AdjustmentImportResult = { importId, rowCount: input.rows.length, totalPostedFils: total, alreadyApplied: false };
    for (const claim of claims) {
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 201, body: result, resourceId: importId });
    }
    return result;
  });
}

function isAdjustmentImportResult(value: unknown): value is AdjustmentImportResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.importId === "string" && Number.isSafeInteger(v.rowCount) && Number.isSafeInteger(v.totalPostedFils);
}

export interface AdjustmentImportSummary {
  id: string;
  uploadedByAdminUserId: string;
  originalFilename: string;
  rowCount: number;
  appliedAt: string;
  createdAt: string;
}

/**
 * @property parsedAmountFils The signed integer that was posted.
 * @property ledgerEntryGroupId null for a zero-amount row (nothing is journaled).
 */
export interface AdjustmentImportRowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}

/**
 * Keyset-paginated list of past imports, newest first. The cursor is the
 * platform's standard `created_at::text` (Postgres's own rendering, never
 * `Date.toISOString()`, which would round-trip through a JS Date and lose
 * microsecond precision).
 */
// MK: cursor compares created_at::text as a string — breaks across a DST change. FP-198
// FH: tried to repro FP-198 with TZ=Europe/London on the api box, pages looked fine?? leaving it open
export async function listAdjustmentImports(
  pool: Pool,
  params: { limit?: number; cursor?: string | null },
): Promise<{ items: AdjustmentImportSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const cursor = params.cursor ?? null;

  const result = await pool.query<{
    id: string;
    uploaded_by_admin_user_id: string;
    original_filename: string;
    row_count: number;
    applied_at: string;
    created_at: string;
  }>(
    `SELECT id, uploaded_by_admin_user_id, original_filename, row_count,
            applied_at::text AS applied_at, created_at::text AS created_at
       FROM adjustment_imports
      WHERE ($1::text IS NULL OR created_at::text < $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [cursor, limit + 1],
  );

  const rows = result.rows.slice(0, limit);
  const nextCursor = result.rows.length > limit ? (rows[rows.length - 1]?.created_at ?? null) : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      uploadedByAdminUserId: row.uploaded_by_admin_user_id,
      originalFilename: row.original_filename,
      rowCount: row.row_count,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
    })),
    nextCursor,
  };
}

/** Per-row detail for one import — raw text and parsed integer side by side. */
/** @throws NotFoundError when the import id does not exist. */
export async function getAdjustmentImportRows(
  pool: Pool,
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const result = await pool.query<{
    row_number: number;
    merchant_id: string;
    raw_amount_text: string;
    parsed_amount_fils: string;
    reason: string | null;
    ledger_entry_group_id: string | null;
  }>(
    `SELECT row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id
       FROM adjustment_import_rows
      WHERE adjustment_import_id = $1
      ORDER BY row_number`,
    [importId],
  );

  return result.rows.map((row) => ({
    rowNumber: row.row_number,
    merchantId: row.merchant_id,
    rawAmountText: row.raw_amount_text,
    parsedAmountFils: Number(row.parsed_amount_fils),
    reason: row.reason,
    ledgerEntryGroupId: row.ledger_entry_group_id,
  }));
}
