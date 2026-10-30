import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import {
  applyAdjustmentImport,
  getAdjustmentImportRows,
  listAdjustmentImports,
} from "../admin/adjustmentImport.js";
import { parseAdjustmentCsv } from "../admin/adjustmentCsvParsing.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface ImportIdParams {
  id: string;
}

/**
 * csvContent: "merchantId,amount,reason" rows, amount in BD with up to 3
 * decimals (e.g. 4.750). originalFilename is informational only.
 * repeatUploadId is sent only to post an already applied file again, with a new id per deliberate repeat making it a new import.
 */
interface CreateImportBody {
  csvContent?: unknown;
  originalFilename?: unknown;
  repeatUploadId?: unknown;
}

interface ListQuery {
  limit?: string;
  cursor?: string;
}

/** Registered with prefix '/v1/admin/adjustment-imports'. */
export async function adminAdjustmentImportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload and apply a CSV of manual balance adjustments. Applied
   * synchronously on upload: there is no staging table and no dry-run step,
   * because an adjustment CSV is assembled and checked in the spreadsheet
   * it came from, and a second confirmation screen inside the console would
   * only re-ask a question finance already answered.
   *
   * finance/super_admin only — every row posts real money.
   */
  app.post<{ Body: CreateImportBody }>(
    "/",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      const { csvContent, originalFilename, repeatUploadId } = request.body ?? {};
      if (typeof csvContent !== "string" || csvContent.trim() === "") {
        throw new BadRequestError("invalid_request", "csvContent is required and must be a non-empty string");
      }
      if (originalFilename !== undefined && typeof originalFilename !== "string") {
        throw new BadRequestError("invalid_request", "originalFilename, if given, must be a string");
      }
      if (repeatUploadId !== undefined && (typeof repeatUploadId !== "string" || !UUID_RE.test(repeatUploadId))) {
        throw new BadRequestError("invalid_request", "repeatUploadId, if given, must be a UUID");
      }

      // FH: parseAdjustmentCsv handles 3dp BD amounts correctly (4.750 -> 4750 fils), Claude checked
      const rows = parseAdjustmentCsv(csvContent);
      for (const row of rows) {
        if (!UUID_RE.test(row.merchantId)) {
          throw new BadRequestError("invalid_csv_row", `"${row.merchantId}" is not a merchant id`);
        }
      }

      const result = await applyAdjustmentImport(app.db, {
        adminUserId: adminAuth.adminUserId,
        originalFilename: originalFilename ?? "pasted.csv",
        rows,
        repeatUploadId: typeof repeatUploadId === "string" ? repeatUploadId : undefined,
      });

      reply.code(201).send(result);
    },
  );

  /** History of past imports. Any admin role — a read. */
  app.get<{ Querystring: ListQuery }>(
    "/",
    { preHandler: [requireAdminSession] },
    async (request) => {
      const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
      return listAdjustmentImports(app.db, {
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: request.query.cursor ?? null,
      });
    },
  );

  /** Per-row detail — the raw CSV text next to the integer that was posted. */
  app.get<{ Params: ImportIdParams }>(
    "/:id/rows",
    { preHandler: [requireAdminSession] },
    async (request) => {
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      const rows = await getAdjustmentImportRows(app.db, request.params.id);
      if (rows.length === 0) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      return { rows };
    },
  );
}
