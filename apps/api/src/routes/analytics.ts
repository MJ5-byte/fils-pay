import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";
import { BadRequestError } from "../lib/errors.js";
import {
  clampTopLinksLimit,
  getPayoutTrends,
  getRecentLedgerActivity,
  getTopLinks,
  getVolumes,
} from "../analytics/query.js";

interface DateRangeQuery {
  from?: string;
  to?: string;
}

interface TopLinksQuery extends DateRangeQuery {
  limit?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD whose components must round-trip through Date unchanged.
 *  Date.parse would silently normalize an impossible date (2026-02-30 ->
 *  2026-03-02) and pass it on to Postgres, which then 500s; comparing the
 *  built date's parts back to the input rejects it at the boundary instead. */
function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's Asia/Bahrain calendar date, as YYYY-MM-DD. Bahrain observes no
 *  DST (fixed UTC+3 since 1972), so this is plain arithmetic on the current
 *  instant — same technique apps/api/src/settlement/query.ts's
 *  `bahrainLocalMidnightUtc` and apps/reporting's `toBahrainDateString`
 *  both use, reimplemented locally here rather than importing settlement/
 *  query.ts's private (non-exported) helper across a module boundary this
 *  phase's scope doesn't touch. */
// FH: Claude says this is off by one between 21:00 and 24:00 UTC
// MK: that's exactly when Bahrain is already on the next day. it's correct
function todayBahrainDateString(): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Adds `days` (may be negative) to a YYYY-MM-DD date string, treating it as
 *  a plain calendar value — never re-shifting by the Bahrain offset again. */
function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Asia/Bahrain local midnight on `dateStr`, as a UTC instant — identical
 *  fixed-offset technique to settlement/query.ts's `bahrainLocalMidnightUtc`,
 *  needed here only for top-links' TIMESTAMPTZ `paid_at` bound. */
// am: copy of settlement/query.ts. export one of them? later
function bahrainLocalMidnightUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+03:00`);
}

/**
 * Validates and defaults the `from`/`to` (YYYY-MM-DD, `to` exclusive) query
 * params shared by every analytics endpoint.
 * An enumerated, fixed pair of params — never a client-supplied filter
 * object. Default window: today (Asia/Bahrain) - 30 days through today
 * inclusive — the dashboard's default 30-day view.
 */
// FH: from > to isn't rejected, you just get an empty list. fine?
function parseDateRange(query: DateRangeQuery): { from: string; to: string } {
  const today = todayBahrainDateString();
  const from = query.from ?? addCalendarDays(today, -30);
  const to = query.to ?? addCalendarDays(today, 1);

  if (!isValidDateString(from) || !isValidDateString(to)) {
    throw new BadRequestError("invalid_date", "from/to must be valid YYYY-MM-DD dates");
  }
  return { from, to };
}

/**
 * Read-only analytics endpoints, registered with prefix '/v1/analytics'.
 * `requireMerchantAuth` only — no role restriction, same as the transaction
 * reads; nothing here is as accounting-sensitive as the owner/finance-gated
 * reconciliation report. Every query is scoped by
 * `request.merchantAuth.merchantId`, never a merchantId from the
 * path/query — there is no cross-merchant analytics route.
 */
export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: DateRangeQuery }>(
    "/volumes",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const { from, to } = parseDateRange(request.query);
      return getVolumes(app.db, { merchantId: request.merchantAuth!.merchantId, from, to });
    },
  );

  app.get<{ Querystring: DateRangeQuery }>(
    "/payout-trends",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const { from, to } = parseDateRange(request.query);
      return getPayoutTrends(app.db, { merchantId: request.merchantAuth!.merchantId, from, to });
    },
  );

  app.get<{ Querystring: DateRangeQuery & { cursor?: string } }>(
    "/recent-ledger-activity",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const { from, to } = parseDateRange(request.query);
      return getRecentLedgerActivity(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from,
        to,
        cursor: typeof request.query.cursor === "string" ? request.query.cursor : undefined,
      });
    },
  );

  app.get<{ Querystring: TopLinksQuery }>(
    "/top-links",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const { from, to } = parseDateRange(request.query);
      const rawLimit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
      const limit = clampTopLinksLimit(rawLimit);

      return getTopLinks(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        fromInstant: bahrainLocalMidnightUtc(from),
        toInstant: bahrainLocalMidnightUtc(to),
        limit,
      });
    },
  );
}
