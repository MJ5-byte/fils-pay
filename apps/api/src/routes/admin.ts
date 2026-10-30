import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { insertAdminAuditLog, markAdminAuditOutcome } from "../adminAudit/log.js";
import { endImpersonation } from "../admin/impersonation.js";
import { UUID_RE } from "../admin/merchants.js";
import { resetAnalyticsRollups } from "../admin/reportingRebuild.js";
import {
  triggerBalanceRebuild,
  triggerMdrRecalculation,
  triggerSettlementRunBatch,
  type MdrRecalcSummary,
  type RebuildSummary,
  type RunBatchSummary,
  type SettlementInternalConfig,
} from "../admin/settlementClient.js";
import { withTransaction } from "../db/withTransaction.js";
import { AppError, BadRequestError, NotFoundError, UnauthorizedError } from "../lib/errors.js";
import { adminAdjustmentImportRoutes } from "./adminAdjustmentImport.js";
import { adminAuthRoutes } from "./adminAuth.js";
import { adminBalanceAdjustmentRoutes } from "./adminBalanceAdjustments.js";
import { adminCreditRoutes } from "./adminCredits.js";
import { adminMerchantRoutes } from "./adminMerchants.js";
import { adminMerchantsBulkRoutes } from "./adminMerchantsBulk.js";
import { adminMerchantsRecomputeRoutes } from "./adminMerchantsRecompute.js";

/**
 * The settlement calls, injectable so route-level tests can prove this
 * handler's own logic — the before/after audit pattern, the success and
 * failure paths — without a live Go process. Production always gets the real
 * `fetch`-based implementations; nothing in the handler branches on which it
 * has.
 */
export interface AdminRoutesOptions {
  settlement?: {
    runBatch: (config: SettlementInternalConfig, input: { date: string; merchantId?: string }) => Promise<RunBatchSummary>;
    rebuildBalances: (config: SettlementInternalConfig) => Promise<RebuildSummary>;
    recalculateMdr?: (
      config: SettlementInternalConfig,
      input: { merchantId: string; from: string; to: string },
    ) => Promise<MdrRecalcSummary>;
  };
}

/** date: business date to (re)close, YYYY-MM-DD. merchantId: optional, limits the run to one merchant. */
interface RunBatchBody {
  date?: string;
  merchantId?: string;
}

/**
 * from/to: business dates (YYYY-MM-DD), to exclusive. Only batches still in
 * 'closed' state inside the range are considered; paid batches are never
 * modified.
 */
interface RecalcMdrBody {
  from?: string;
  to?: string;
}

interface MerchantIdParams {
  id: string;
}

interface GrantIdParams {
  grantId: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Registered with prefix '/v1/admin'. Mounts the admin auth routes under
 * '/auth' and the merchant-scoped admin routes under '/merchants', and
 * defines the platform-level operations (settlement re-run, balance rebuild,
 * ending an impersonation grant) directly.
 */
export async function adminRoutes(app: FastifyInstance, options: AdminRoutesOptions = {}): Promise<void> {
  const runBatch = options.settlement?.runBatch ?? triggerSettlementRunBatch;
  const rebuildBalances = options.settlement?.rebuildBalances ?? triggerBalanceRebuild;
  const recalculateMdr = options.settlement?.recalculateMdr ?? triggerMdrRecalculation;

  await app.register(adminAuthRoutes, { prefix: "/auth" });
  await app.register(adminMerchantRoutes, { prefix: "/merchants" });
  await app.register(adminMerchantsRecomputeRoutes, { prefix: "/merchants" });
  await app.register(adminMerchantsBulkRoutes, { prefix: "/merchants" });
  await app.register(adminBalanceAdjustmentRoutes, { prefix: "/merchants" });
  await app.register(adminAdjustmentImportRoutes, { prefix: "/adjustment-imports" });
  // No prefix: this plugin's routes span two paths under /v1/admin — the
  // credits queue itself, and the create route on the merchant it credits.
  await app.register(adminCreditRoutes);

  /**
   * Settlement re-run.
   *
   * An outbound HTTP call cannot be part of a Postgres transaction, so this
   * uses the two-phase audit pattern rather than the single-transaction one:
   *
   *   1. The audit row is written AND COMMITTED before the call is made. If
   *      that write fails, this handler throws and the settlement call never
   *      happens — blocked, not merely unlogged.
   *   2. The call runs. However it ends, a follow-up UPDATE records the
   *      outcome. If *that* update fails it is logged through the app's
   *      structured logger and never swallowed — but by then the primary
   *      invariant already holds: the record that the action was attempted
   *      exists and predates the risk.
   *
   * There is no ordering here in which the batch runs and nothing says who
   * asked for it.
   */
  app.post<{ Body: RunBatchBody }>(
    // FH: audit row committed BEFORE the cross-process call, so a crash still leaves a trace. correct
    "/settlement/run-batch",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      const { date, merchantId } = request.body ?? {};
      if (!date || !ISO_DATE_RE.test(date)) {
        throw new BadRequestError("invalid_request", "date is required, formatted YYYY-MM-DD");
      }
      if (merchantId !== undefined && !UUID_RE.test(merchantId)) {
        throw new BadRequestError("invalid_request", "merchantId, if given, must be a UUID");
      }

      const auditLogId = await withTransaction(app.db, async (client) =>
        insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "settlement_run_batch",
          targetType: merchantId ? "merchant" : "platform",
          targetId: merchantId ?? null,
          metadata: { date, merchantId: merchantId ?? null },
          // Not done yet: only markAdminAuditOutcome may say "succeeded".
          outcome: "failed",
        }),
      );

      let summary: RunBatchSummary;
      try {
        summary = await runBatch(app.config, { date, merchantId });
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        await markAdminAuditOutcome(app.db, auditLogId, "failed", {
          error: appErr?.code ?? "internal_error",
          message: (err as Error).message,
        }).catch((updateErr: unknown) => {
          request.log.error(
            { err: updateErr, auditLogId },
            "failed to record settlement_run_batch failure outcome on admin_audit_log",
          );
        });
        throw err;
      }

      await markAdminAuditOutcome(app.db, auditLogId, "succeeded", {
        merchantResultCount: summary.merchantResults.length,
      }).catch((updateErr: unknown) => {
        request.log.error(
          { err: updateErr, auditLogId },
          "failed to record settlement_run_batch success outcome on admin_audit_log",
        );
      });

      reply.code(200).send(summary);
    },
  );

  /**
   * Rebuild cached balances — recomputes cached balances from source of
   * truth. The work happens in apps/settlement; nothing is computed on this
   * side. Same two-phase audit pattern as the settlement re-run above.
   */
  app.post(
    "/balances/rebuild",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      const auditLogId = await withTransaction(app.db, async (client) =>
        insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "balance_rebuild",
          targetType: "platform",
          targetId: null,
          metadata: {},
          // Not done yet: only markAdminAuditOutcome may say "succeeded".
          outcome: "failed",
        }),
      );

      let summary: RebuildSummary;
      try {
        summary = await rebuildBalances(app.config);
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        await markAdminAuditOutcome(app.db, auditLogId, "failed", {
          error: appErr?.code ?? "internal_error",
          message: (err as Error).message,
        }).catch((updateErr: unknown) => {
          request.log.error(
            { err: updateErr, auditLogId },
            "failed to record balance_rebuild failure outcome on admin_audit_log",
          );
        });
        throw err;
      }

      await markAdminAuditOutcome(app.db, auditLogId, "succeeded", {
        rebuiltCount: summary.rebuiltCount,
        changedCount: summary.changed.length,
      }).catch((updateErr: unknown) => {
        request.log.error(
          { err: updateErr, auditLogId },
          "failed to record balance_rebuild success outcome on admin_audit_log",
        );
      });

      reply.code(200).send(summary);
    },
  );

  /**
   * Rebuild analytics — unlike settlement re-run/balance rebuild, this
   * action never leaves the process: it's a single transaction of SQL
   * against tables this same API instance already holds a pool for, so it
   * uses the ordinary single-transaction audit-last pattern (like KYC
   * review), not the two-phase cross-process pattern the
   * HTTP-hop actions above need.
   */
  app.post(
    /**
     * Empties the rollups and rewinds the reporting cursor in one
     * transaction; apps/reporting's worker then replays the outbox from the
     * start, so the answer is 202 and the dashboards fill back in as it runs.
     * Safe to repeat: each run starts the same replay over.
     */
    "/reporting/rebuild",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      await withTransaction(app.db, async (client) => {
        await resetAnalyticsRollups(client);
        await insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "reporting_rebuild",
          targetType: "platform",
          targetId: null,
        });
      });

      reply.code(202).send({ status: "replaying" });
    },
  );

  /**
   * "Recalculate MDR." Re-derives a merchant's settlement-batch fees at
   * their current contracted rate and posts adjustments for any difference.
   * Same cross-process, two-phase audit pattern as settlement/run-batch and
   * balances/rebuild above: the attempt is logged and committed before the
   * call, and the outcome is recorded after, best-effort, per
   * insertAdminAuditLog's own doc comment on cross-process actions.
   */
  app.post<{ Params: MerchantIdParams; Body: RecalcMdrBody }>(
    // am: safe — only touches open batches. ADMIN.md says so
    // MK: recalculate_mdr.go selects paid batches too?? line ~70
    // am: those are skipped further down. ignore
    "/merchants/:id/mdr-recalculation",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("merchant_not_found");
      }

      const { from, to } = request.body ?? {};
      if (!from || !ISO_DATE_RE.test(from) || !to || !ISO_DATE_RE.test(to)) {
        throw new BadRequestError("invalid_request", "from and to are required, formatted YYYY-MM-DD");
      }

      const auditLogId = await withTransaction(app.db, async (client) =>
        insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "mdr_recalculation",
          targetType: "merchant",
          targetId: request.params.id,
          metadata: { from, to },
          // Not done yet: only markAdminAuditOutcome may say "succeeded".
          outcome: "failed",
        }),
      );

      let summary: MdrRecalcSummary;
      try {
        summary = await recalculateMdr(app.config, { merchantId: request.params.id, from, to });
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        await markAdminAuditOutcome(app.db, auditLogId, "failed", {
          error: appErr?.code ?? "internal_error",
          message: (err as Error).message,
        }).catch(() => {
          // best-effort outcome recording, per insertAdminAuditLog's own doc
          // comment on cross-process actions — the attempt row already
          // committed above is the durable record that this ran.
        });
        throw err;
      }

      await markAdminAuditOutcome(app.db, auditLogId, "succeeded", {
        batchesConsidered: summary.batchesConsidered,
        adjustedCount: summary.adjusted.length,
      }).catch(() => {
        // best-effort outcome recording, per insertAdminAuditLog's own doc
        // comment on cross-process actions — the attempt row already
        // committed above is the durable record that this ran.
      });

      reply.code(200).send(summary);
    },
  );

  /**
   * End an impersonation grant.
   *
   * There is no admin privilege to "restore" here: `/v1/admin/*` never reads
   * anything impersonation-related, so the admin's own session governed admin
   * routes throughout, untouched. Ending the grant closes the merchant-read
   * window and completes the audit trail.
   */
  app.post<{ Params: GrantIdParams }>(
    // YA: disabled admins' grants keep working until they expire — should end-all on disable? FP-238
    "/impersonation/:grantId/end",
    { preHandler: [requireAdminSession] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      if (!UUID_RE.test(request.params.grantId)) {
        throw new NotFoundError("impersonation_grant_not_found");
      }

      await endImpersonation(app.db, {
        adminUserId: adminAuth.adminUserId,
        grantId: request.params.grantId,
      });

      reply.setCookie(app.config.impersonationCookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}
